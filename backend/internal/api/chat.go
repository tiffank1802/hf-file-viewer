package api

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"enise-docs/backend/internal/appwrite"
	"enise-docs/backend/internal/cache"
	"enise-docs/backend/internal/catalog"
	"enise-docs/backend/internal/chat"
)

const (
	chatReadLimit     = 8 << 20
	chatReadableMax   = 25 << 20
	chatBodyLimit     = 384 << 10
	chatRateLimit     = 30
	chatExcerptWait   = 15 * time.Second
	chatAnswerWait    = 45 * time.Second
	chatExcerptRunes  = 7000
	chatCardRunes     = 280
	chatPromptRunes   = 3500
	defaultChatModel  = "meta/llama-3.1-8b-instruct"
	nvidiaMissingNote = "L’analyse rédigée par l’IA n’est pas activée sur ce serveur. Tu peux déjà ouvrir les documents proposés."
)

type chatRequest struct {
	Message        string               `json:"message"`
	ContextPath    string               `json:"contextPath"`
	ConversationID string               `json:"conversationId"`
	Provider       string               `json:"provider"`
	Model          string               `json:"model"`
	History        []chatTurn           `json:"history"`
	Catalog        []catalog.BucketItem `json:"catalog"`
}

type chatTurn struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type nvidiaMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatLimiter struct {
	mu   sync.Mutex
	hits map[string][]time.Time
}

func newChatLimiter() *chatLimiter {
	return &chatLimiter{hits: map[string][]time.Time{}}
}

func (l *chatLimiter) allow(key string) bool {
	if l == nil {
		return true
	}
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.hits == nil {
		l.hits = map[string][]time.Time{}
	}
	recent := make([]time.Time, 0, len(l.hits[key])+1)
	for _, hit := range l.hits[key] {
		if now.Sub(hit) < time.Minute {
			recent = append(recent, hit)
		}
	}
	if len(recent) >= chatRateLimit {
		l.hits[key] = recent
		return false
	}
	l.hits[key] = append(recent, now)
	if len(l.hits) > 2000 {
		for id, values := range l.hits {
			if len(values) == 0 || now.Sub(values[len(values)-1]) >= time.Minute {
				delete(l.hits, id)
			}
		}
	}
	return true
}

func (s *Server) handleChatStatus(w http.ResponseWriter, r *http.Request) error {
	providers := s.chatProviders()
	primary := "local"
	primaryModel := ""
	status := "not-configured"
	for _, provider := range providers {
		if provider["enabled"] == true {
			status = "ready"
			primary, _ = provider["id"].(string)
			primaryModel, _ = provider["model"].(string)
			break
		}
	}
	writeJSON(w, r, http.StatusOK, map[string]any{
		"ok":        true,
		"status":    status,
		"engine":    primary,
		"model":     primaryModel,
		"providers": providers,
		"index":     s.indexLabel(),
		"backend":   "go",
	}, "no-store", nil)
	return nil
}

func (s *Server) chatProviders() []map[string]any {
	return []map[string]any{
		{
			"id":      "openrouter",
			"label":   "OpenRouter",
			"model":   s.cfg.OpenRouterModel,
			"enabled": strings.TrimSpace(s.cfg.OpenRouterAPIKey) != "",
			"models": []map[string]any{
				{"id": "openai/gpt-oss-120b:free", "label": "GPT-OSS 120B", "free": true, "reasoning": true},
				{"id": "nvidia/nemotron-3-ultra-550b-a55b:free", "label": "Nemotron 3 Ultra", "free": true, "reasoning": true},
				{"id": "nvidia/nemotron-3-super-120b-a12b:free", "label": "Nemotron 3 Super", "free": true, "reasoning": true},
				{"id": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", "label": "Nemotron Nano Omni", "free": true, "reasoning": true},
				{"id": "poolside/laguna-m.1:free", "label": "Laguna M.1", "free": true, "reasoning": true},
				{"id": "cohere/north-mini-code:free", "label": "North Mini Code", "free": true, "reasoning": true},
			},
		},
		{
			"id":      "nvidia",
			"label":   "NVIDIA",
			"model":   s.cfg.NvidiaModel,
			"enabled": strings.TrimSpace(s.cfg.NvidiaAPIKey) != "",
			"models": []map[string]any{
				{"id": "nvidia/nemotron-3-ultra-550b-a55b", "label": "Nemotron 3 Ultra", "free": true, "reasoning": true},
				{"id": "nvidia/nemotron-3-super-120b-a12b", "label": "Nemotron 3 Super", "free": true, "reasoning": true},
				{"id": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", "label": "Nemotron Nano Omni", "free": true, "reasoning": true},
				{"id": "openai/gpt-oss-120b", "label": "GPT-OSS 120B", "free": true, "reasoning": true},
				{"id": "deepseek-ai/deepseek-v4-pro", "label": "DeepSeek V4 Pro", "free": true, "reasoning": true},
				{"id": "z-ai/glm-5.1", "label": "GLM-5.1", "free": true, "reasoning": true},
			},
		},
		{
			"id":      "opencode",
			"label":   "OpenCode",
			"model":   s.cfg.OpenCodeModel,
			"enabled": strings.TrimSpace(s.cfg.OpenCodeAPIKey) != "",
			"models": []map[string]any{
				{"id": "nemotron-3-ultra-free", "label": "Nemotron 3 Ultra", "free": true, "reasoning": true},
				{"id": "nemotron-3.5-lightning-free", "label": "Nemotron 3.5 Lightning", "free": true, "reasoning": true},
				{"id": "deepseek-v4-flash-free", "label": "DeepSeek V4 Flash", "free": true, "reasoning": true},
				{"id": "mimo-v2.5-free", "label": "MiMo-V2.5", "free": true, "reasoning": true},
				{"id": "minimax-m2.5-free", "label": "MiniMax M2.5", "free": true, "reasoning": true},
				{"id": "big-pickle", "label": "Big Pickle", "free": true, "reasoning": true},
			},
		},
	}
}

func (s *Server) handleChat(w http.ResponseWriter, r *http.Request) error {
	if !s.chatHits.allow(s.chatClientKey(r)) {
		return catalog.Error(http.StatusTooManyRequests, "Trop de questions d’un coup. Réessaie dans une minute.")
	}
	body, err := readChatRequest(w, r)
	if err != nil {
		return err
	}
	message := strings.TrimSpace(body.Message)
	switch {
	case message == "":
		return catalog.Error(http.StatusBadRequest, "Écris une question sur la bibliothèque.")
	case len([]rune(message)) > 2000:
		return catalog.Error(http.StatusBadRequest, "La question est trop longue (2000 caractères maximum).")
	}

	contextPath, err := catalog.NormalizePrefix(body.ContextPath)
	if err != nil {
		contextPath = ""
	}
	items, _ := s.chatCorpus(body)
	header := w.Header()
	header.Set("Content-Type", "text/event-stream; charset=utf-8")
	header.Set("Cache-Control", "no-store, no-transform")
	header.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	if len(chat.Tokens(message)) == 0 {
		answer := "Formule une question avec une matière, une année (3A, 4A, 5A) ou TOEIC."
		_ = writeSSE(w, "delta", map[string]string{"text": answer})
		s.finishChat(w, r, body.ConversationID, message, answer, contextPath, "local", nil)
		return nil
	}
	if len(items) == 0 {
		answer := "La bibliothèque n’est pas encore indexée. Réessaie dans un instant."
		_ = writeSSE(w, "delta", map[string]string{"text": answer})
		s.finishChat(w, r, body.ConversationID, message, answer, contextPath, "local", nil)
		return nil
	}

	hits := chat.ExpandForReading(items, chat.Rank(items, message, contextPath, 6), 6)
	if err := writeSSE(w, "sources", map[string]any{"documents": publicHits(hits)}); err != nil {
		return nil
	}
	s.enrichHits(r.Context(), hits)
	if anyRead(hits) {
		_ = writeSSE(w, "sources", map[string]any{"documents": publicHits(hits)})
	}

	answer, engine := s.composeAnswer(r.Context(), w, message, contextPath, sanitizeHistory(body.History, message), hits, body.Provider, body.Model)
	s.finishChat(w, r, body.ConversationID, message, answer, contextPath, engine, hits)
	return nil
}

func (s *Server) finishChat(w http.ResponseWriter, r *http.Request, conversationID, question, answer, contextPath, engine string, hits []chat.Hit) {
	hits = promoteMentioned(answer, hits)
	saved := s.rememberChat(r, conversationID, question, answer, contextPath, hits)
	_ = writeSSE(w, "done", map[string]any{
		"answer":         answer,
		"engine":         engine,
		"documents":      publicHits(hits),
		"conversationId": saved.ID,
		"title":          saved.Title,
		"saved":          saved.ID != "",
		"saveError":      saved.Error,
	})
}

type chatSave struct {
	ID    string
	Title string
	Error string
}

func (s *Server) rememberChat(r *http.Request, conversationID, question, answer, contextPath string, hits []chat.Hit) chatSave {
	secret := sessionFrom(r)
	if secret == "" || !s.authReady() {
		return chatSave{}
	}
	if !s.appwrite().HasChats() {
		return chatSave{Error: "Conversations non configurées."}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	user, err := s.appwrite().GetAccount(ctx, secret)
	if err != nil {
		log.Printf("chat mémoire: session illisible: %v", err)
		return chatSave{Error: "Session non reconnue : la conversation n’a pas été enregistrée."}
	}
	saved, err := s.appwrite().AppendChatTurn(ctx, secret, user.ID, conversationID, question, answer, contextPath, chatSources(hits))
	if err != nil {
		log.Printf("chat mémoire: %v", err)
		if appwrite.IsMissingTable(err) {
			return chatSave{Error: "Lance npm run appwrite:setup pour garder les conversations."}
		}
		detail := appwrite.French(err)
		var apiErr *appwrite.APIError
		if errors.As(err, &apiErr) && apiErr != nil && apiErr.Detail != "" {
			detail = apiErr.Detail
		}
		if len(detail) > 180 {
			detail = detail[:180]
		}
		return chatSave{Error: "Conversation non enregistrée : " + detail}
	}
	return chatSave{ID: saved.ID, Title: saved.Title}
}

func chatSources(hits []chat.Hit) []appwrite.ChatSource {
	out := make([]appwrite.ChatSource, 0, len(hits))
	for _, hit := range hits {
		if hit.Path == "" {
			continue
		}
		out = append(out, appwrite.ChatSource{Path: hit.Path, Name: hit.Name, Type: hit.Type})
	}
	return out
}

func (s *Server) handleChatHistory(w http.ResponseWriter, r *http.Request) error {
	if !s.authReady() || !s.appwrite().HasChats() {
		writeJSON(w, r, http.StatusOK, map[string]any{
			"ok": true, "enabled": false, "items": []any{}, "messages": []any{},
		}, "no-store", nil)
		return nil
	}
	secret := sessionFrom(r)
	if secret == "" {
		return catalog.Error(http.StatusUnauthorized, "Connecte-toi pour retrouver tes conversations.")
	}
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	user, err := s.appwrite().GetAccount(ctx, secret)
	if err != nil {
		if authStatus(err) == http.StatusUnauthorized {
			return catalog.Error(http.StatusUnauthorized, "Session expirée. Reconnecte-toi.")
		}
		return s.authFail(err)
	}
	switch {
	case r.URL.Path == "/api/chat/conversations" && r.Method == http.MethodGet:
		items, err := s.appwrite().ListChatConversations(ctx, secret, user.ID)
		if err != nil {
			if appwrite.IsMissingTable(err) {
				writeJSON(w, r, http.StatusOK, map[string]any{
					"ok": true, "enabled": true, "unprovisioned": true, "items": []any{},
					"error": "Lance npm run appwrite:setup pour garder les conversations.",
				}, "no-store", nil)
				return nil
			}
			return s.authFail(err)
		}
		if items == nil {
			items = []appwrite.ChatConversation{}
		}
		writeJSON(w, r, http.StatusOK, map[string]any{"ok": true, "enabled": true, "items": items}, "no-store", nil)
		return nil
	case strings.HasPrefix(r.URL.Path, "/api/chat/conversations/") && r.Method == http.MethodGet:
		id := strings.TrimPrefix(r.URL.Path, "/api/chat/conversations/")
		messages, err := s.appwrite().ListChatMessages(ctx, secret, user.ID, id)
		if err != nil {
			return s.authFail(err)
		}
		if messages == nil {
			messages = []appwrite.ChatMessage{}
		}
		writeJSON(w, r, http.StatusOK, map[string]any{
			"ok": true, "conversationId": id, "messages": messages,
		}, "no-store", nil)
		return nil
	default:
		w.Header().Set("Allow", "GET")
		return catalog.Error(http.StatusMethodNotAllowed, "Méthode "+r.Method+" non autorisée.")
	}
}

func readChatRequest(w http.ResponseWriter, r *http.Request) (chatRequest, error) {
	r.Body = http.MaxBytesReader(w, r.Body, chatBodyLimit)
	var body chatRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		return chatRequest{}, catalog.Error(http.StatusBadRequest, "La question n’a pas pu être lue.")
	}
	return body, nil
}

func (s *Server) chatCorpus(body chatRequest) ([]catalog.BucketItem, string) {
	if doc, _, state := s.cache.Index(); doc != nil && len(doc.Items) > 0 && state != "" {
		return doc.Items, state
	}
	if len(body.Catalog) == 0 || len(body.Catalog) > 400 {
		return nil, "cold"
	}
	items := make([]catalog.BucketItem, 0, len(body.Catalog))
	for _, item := range body.Catalog {
		path, err := catalog.NormalizeFilePath(item.Path)
		if err != nil {
			continue
		}
		if item.Type != "directory" {
			item.Type = "file"
		}
		item.Path = path
		items = append(items, item)
	}
	return items, "client"
}

func (s *Server) enrichHits(ctx context.Context, hits []chat.Hit) {
	ctx, cancel := context.WithTimeout(ctx, chatExcerptWait)
	defer cancel()
	var wg sync.WaitGroup
	sem := make(chan struct{}, 3)
	for i := range hits {
		if i >= 2 || !chat.Readable(hits[i].Path, hits[i].Type, hits[i].Size, chatReadableMax) {
			continue
		}
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				return
			}
			text := s.excerpt(ctx, catalog.BucketItem{
				Type:  hits[i].Type,
				Path:  hits[i].Path,
				Size:  hits[i].Size,
				Mtime: hits[i].Mtime,
			})
			if text == "" {
				return
			}
			hits[i].Excerpt = text
			hits[i].Read = true
		}(i)
	}
	wg.Wait()
}

func (s *Server) excerpt(ctx context.Context, item catalog.BucketItem) string {
	key := excerptKey(item)
	if entry, state := s.cache.GetBlob(key); state != "" && len(entry.Body) > 0 {
		return string(entry.Body)
	}
	value, err := s.cache.Do(key, func() (any, error) {
		if entry, state := s.cache.GetBlob(key); state != "" && len(entry.Body) > 0 {
			return string(entry.Body), nil
		}
		payload, err := s.downloadChatPrefix(ctx, item.Path, chatReadLimit)
		if err != nil {
			log.Printf("chat lecture %s: %v", item.Path, err)
			return "", nil
		}
		text := chat.Extract(item.Path, payload, chatExcerptRunes)
		if text == "" {
			return "", nil
		}
		now := time.Now()
		s.cache.PutBlob(key, cache.Entry{
			Body:        []byte(text),
			ContentType: "text/plain; charset=utf-8",
			FreshUntil:  now.Add(6 * time.Hour),
			StaleUntil:  now.Add(24 * time.Hour),
		})
		return text, nil
	})
	if err != nil || value == nil {
		return ""
	}
	text, _ := value.(string)
	return text
}

func excerptKey(item catalog.BucketItem) string {
	size := "0"
	if item.Size != nil {
		size = fmt.Sprintf("%d", *item.Size)
	}
	return "chat-excerpt:" + item.Path + ":" + size + ":" + item.Mtime
}

func (s *Server) composeAnswer(ctx context.Context, w http.ResponseWriter, message, contextPath string, history []chatTurn, hits []chat.Hit, providerID, modelOverride string) (string, string) {
	provider := s.resolveChatProvider(providerID, modelOverride)
	if len(hits) == 0 || provider == nil {
		note := ""
		if len(hits) > 0 {
			note = nvidiaMissingNote
		}
		answer := localAnswer(hits, note)
		_ = writeSSE(w, "delta", map[string]string{"text": answer})
		return answer, "local"
	}

	answerCtx, cancel := context.WithTimeout(ctx, chatAnswerWait)
	defer cancel()
	var streamed strings.Builder
	err := s.streamChatCompletion(answerCtx, provider, s.nvidiaMessages(message, contextPath, history, hits), func(delta string) error {
		streamed.WriteString(delta)
		return writeSSE(w, "delta", map[string]string{"text": delta})
	})
	if err != nil || streamed.Len() == 0 {
		if streamed.Len() > 0 {
			return ensureStructure(streamed.String(), hits), provider.id
		}
		note := nvidiaFailureNote(err, provider.label)
		answer := localAnswer(hits, note)
		_ = writeSSE(w, "delta", map[string]string{"text": answer})
		return answer, "local"
	}
	return ensureStructure(streamed.String(), hits), provider.id
}

type chatProvider struct {
	id      string
	label   string
	baseURL string
	apiKey  string
	model   string
}

func (s *Server) resolveChatProvider(providerID, modelOverride string) *chatProvider {
	providerID = strings.ToLower(strings.TrimSpace(providerID))
	modelOverride = sanitizeModel(modelOverride)
	candidates := []*chatProvider{
		{
			id: "openrouter", label: "OpenRouter",
			baseURL: s.cfg.OpenRouterAPIBase, apiKey: s.cfg.OpenRouterAPIKey,
			model: firstNonEmpty(modelOverride, s.cfg.OpenRouterModel),
		},
		{
			id: "nvidia", label: "NVIDIA",
			baseURL: s.cfg.NvidiaAPIBase, apiKey: s.cfg.NvidiaAPIKey,
			model: firstNonEmpty(modelOverride, s.cfg.NvidiaModel),
		},
		{
			id: "opencode", label: "OpenCode",
			baseURL: s.cfg.OpenCodeAPIBase, apiKey: s.cfg.OpenCodeAPIKey,
			model: firstNonEmpty(modelOverride, s.cfg.OpenCodeModel),
		},
	}
	var firstReady *chatProvider
	for _, candidate := range candidates {
		if strings.TrimSpace(candidate.apiKey) == "" || candidate.model == "" {
			continue
		}
		if firstReady == nil {
			firstReady = candidate
		}
		if providerID == "" || providerID == candidate.id {
			return candidate
		}
	}
	return firstReady
}

func (s *Server) nvidiaMessages(message, contextPath string, history []chatTurn, hits []chat.Hit) []nvidiaMessage {
	messages := make([]nvidiaMessage, 0, len(history)+2)
	messages = append(messages, nvidiaMessage{Role: "system", Content: chatSystemPrompt})
	for _, turn := range history {
		messages = append(messages, nvidiaMessage{Role: turn.Role, Content: turn.Content})
	}
	messages = append(messages, nvidiaMessage{Role: "user", Content: documentPrompt(message, contextPath, hits)})
	return messages
}

const chatSystemPrompt = `Tu es l’assistant de la bibliothèque ENISE Docs (Centrale Lyon ENISE).
Tu résumes uniquement les extraits fournis. Tu n’inventes aucun chemin, cours, date ou chiffre.

Réponds en français, avec exactement cette structure markdown :

## Recommandation
Une ou deux phrases : quel document ouvrir, et pourquoi il répond à la question.

## Résumé
Un paragraphe de 5 à 8 lignes qui reformule l’extrait du document principal. S’il n’y a pas d’extrait, dis que le texte n’a pas pu être lu et n’invente pas le contenu.

## Points clés
- trois à six puces concrètes tirées de l’extrait
- si l’extrait manque : une seule puce « Texte non extractible »

## À ouvrir
Le chemin exact du document principal, seul, entre backticks.`

func documentPrompt(question, contextPath string, hits []chat.Hit) string {
	var b strings.Builder
	if contextPath == "" {
		b.WriteString("Dossier ouvert : bibliothèque entière\n")
	} else {
		b.WriteString("Dossier ouvert : ")
		b.WriteString(contextPath)
		b.WriteByte('\n')
	}
	if len(hits) == 0 {
		b.WriteString("Aucun document vérifié.\n")
	} else {
		b.WriteString("Documents vérifiés :\n")
	}
	for i, hit := range hits {
		fmt.Fprintf(&b, "%d. %s\n   chemin : `%s`\n   pourquoi : %s\n", i+1, hit.Name, hit.Path, hit.Reason)
		limit := 1200
		if i == 0 {
			limit = chatPromptRunes
		}
		if hit.Excerpt != "" {
			b.WriteString("   extrait : ")
			b.WriteString(chat.Clip(hit.Excerpt, limit))
			b.WriteByte('\n')
			continue
		}
		b.WriteString("   extrait : aucun texte lisible (fichier image, format fermé ou lecture interrompue). Ne résume pas son contenu.\n")
	}
	b.WriteString("Question : ")
	b.WriteString(question)
	return b.String()
}

func (s *Server) streamChatCompletion(ctx context.Context, provider *chatProvider, messages []nvidiaMessage, onDelta func(string) error) error {
	if provider == nil {
		return fmt.Errorf("provider LLM absent")
	}
	endpoint, err := chatEndpoint(provider.baseURL, provider.label)
	if err != nil {
		return err
	}
	payload, err := json.Marshal(map[string]any{
		"model":       provider.model,
		"messages":    messages,
		"temperature": 0.2,
		"max_tokens":  1100,
		"stream":      true,
	})
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+provider.apiKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "text/event-stream, application/json")
	request.Header.Set("User-Agent", "enise-docs-go")
	if provider.id == "openrouter" {
		request.Header.Set("HTTP-Referer", "https://enise-docs.local")
		request.Header.Set("X-Title", "ENISE Docs")
	}
	response, err := s.client.Do(request)
	if err != nil {
		log.Printf("%s chat injoignable", provider.id)
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		log.Printf("%s chat status %d", provider.id, response.StatusCode)
		return &nvidiaStatusError{status: response.StatusCode}
	}
	contentType := response.Header.Get("Content-Type")
	if strings.Contains(contentType, "application/json") && !strings.Contains(contentType, "text/event-stream") {
		return readNVIDIAJSON(response.Body, onDelta)
	}
	return readNVIDIAStream(response.Body, onDelta)
}

type nvidiaStatusError struct {
	status int
}

func (e *nvidiaStatusError) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("llm status %d", e.status)
}

func nvidiaFailureNote(err error, providerLabel string) string {
	if providerLabel == "" {
		providerLabel = "NVIDIA"
	}
	var statusErr *nvidiaStatusError
	if errors.As(err, &statusErr) {
		switch statusErr.status {
		case http.StatusUnauthorized, http.StatusForbidden:
			return "La clé " + providerLabel + " a été refusée. Les documents ci-dessus viennent quand même de la bibliothèque."
		case http.StatusTooManyRequests:
			return providerLabel + " limite le débit pour le moment. Les documents ci-dessus viennent quand même de la bibliothèque."
		}
	}
	return "La rédaction automatique n’a pas répondu. Les documents ci-dessus viennent quand même de la bibliothèque."
}

func readNVIDIAJSON(body io.Reader, onDelta func(string) error) error {
	payload, err := io.ReadAll(io.LimitReader(body, 1<<20))
	if err != nil {
		return err
	}
	text := completionText(payload)
	if text == "" {
		return io.EOF
	}
	return onDelta(chat.Clip(text, 8000))
}

func readNVIDIAStream(body io.Reader, onDelta func(string) error) error {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
	written := 0
	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), "\r")
		if line == "" || strings.HasPrefix(line, ":") || !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" || data == "[DONE]" {
			if data == "[DONE]" {
				return nil
			}
			continue
		}
		if strings.HasPrefix(data, "{") && strings.Contains(data, "\"error\"") && !strings.Contains(data, "\"choices\"") {
			return io.ErrUnexpectedEOF
		}
		text := completionText([]byte(data))
		if text == "" {
			continue
		}
		if written+len([]rune(text)) > 8000 {
			text = chat.Clip(text, 8000-written)
		}
		if text == "" {
			return nil
		}
		if err := onDelta(text); err != nil {
			return err
		}
		written += len([]rune(text))
		if written >= 8000 {
			return nil
		}
	}
	return scanner.Err()
}

func completionText(payload []byte) string {
	var chunk struct {
		Choices []struct {
			Delta struct {
				Content string `json:"content"`
			} `json:"delta"`
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
			Text string `json:"text"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(payload, &chunk); err != nil || len(chunk.Choices) == 0 {
		return ""
	}
	choice := chunk.Choices[0]
	switch {
	case choice.Delta.Content != "":
		return choice.Delta.Content
	case choice.Message.Content != "":
		return choice.Message.Content
	default:
		return choice.Text
	}
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func sanitizeModel(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 120 {
		return ""
	}
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '/' || r == '.' || r == '_' || r == '-' || r == ':':
		default:
			return ""
		}
	}
	return value
}

func (s *Server) nvidiaReady() bool {
	if strings.TrimSpace(s.cfg.NvidiaAPIKey) == "" {
		return false
	}
	_, err := s.nvidiaEndpoint()
	return err == nil
}

func (s *Server) nvidiaModel() string {
	model := strings.TrimSpace(s.cfg.NvidiaModel)
	if model == "" || len(model) > 120 {
		return defaultChatModel
	}
	for _, r := range model {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '/' || r == '.' || r == '_' || r == '-' || r == ':':
		default:
			return defaultChatModel
		}
	}
	return model
}

func (s *Server) nvidiaEndpoint() (string, error) {
	return chatEndpoint(s.cfg.NvidiaAPIBase, "NVIDIA")
}

func chatEndpoint(rawBase, label string) (string, error) {
	base := strings.TrimRight(strings.TrimSpace(rawBase), "/")
	if base == "" {
		base = "https://integrate.api.nvidia.com/v1"
	}
	if strings.HasSuffix(base, "/chat/completions") {
		base = strings.TrimSuffix(base, "/chat/completions")
	}
	parsed, err := http.NewRequest(http.MethodGet, base, nil)
	if err != nil || parsed.URL == nil || parsed.URL.Host == "" {
		return "", fmt.Errorf("origine %s invalide", label)
	}
	switch parsed.URL.Scheme {
	case "https":
	case "http":
		host := parsed.URL.Hostname()
		if host != "localhost" && host != "127.0.0.1" && !strings.HasPrefix(host, "127.") {
			return "", fmt.Errorf("%s_API_BASE doit être en HTTPS", strings.ToUpper(label))
		}
	default:
		return "", fmt.Errorf("origine %s invalide", label)
	}
	return strings.TrimRight(parsed.URL.String(), "/") + "/chat/completions", nil
}

func (s *Server) indexLabel() string {
	_, _, state := s.cache.Index()
	switch state {
	case "fresh":
		return "ready"
	case "stale":
		return "stale"
	default:
		return "cold"
	}
}

func (s *Server) chatClientKey(r *http.Request) string {
	remote := remoteHost(r.RemoteAddr)
	if s.cfg.ChatTrustProxy || remoteIsPrivate(remote) {
		for _, header := range []string{"X-Enise-Client", "CF-Connecting-IP"} {
			if ip := net.ParseIP(strings.TrimSpace(r.Header.Get(header))); ip != nil {
				return ip.String()
			}
		}
	}
	if remote == "" {
		return "unknown"
	}
	return remote
}

func remoteHost(remote string) string {
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		return remote
	}
	return host
}

func remoteIsPrivate(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && (ip.IsLoopback() || ip.IsPrivate())
}

func sanitizeHistory(turns []chatTurn, message string) []chatTurn {
	if len(turns) > 8 {
		turns = turns[len(turns)-8:]
	}
	out := make([]chatTurn, 0, len(turns))
	for _, turn := range turns {
		if turn.Role != "user" && turn.Role != "assistant" {
			continue
		}
		content := strings.TrimSpace(turn.Content)
		if content == "" {
			continue
		}
		out = append(out, chatTurn{Role: turn.Role, Content: chat.Clip(content, 1000)})
	}
	message = strings.TrimSpace(message)
	if len(out) > 0 && out[len(out)-1].Role == "user" && out[len(out)-1].Content == message {
		out = out[:len(out)-1]
	}
	return out
}

func localAnswer(hits []chat.Hit, note string) string {
	if len(hits) == 0 {
		return "Je n’ai pas trouvé de document qui corresponde. Essaie avec le nom d’un cours, une année (3A, 4A, 5A) ou TOEIC."
	}
	top := hits[0]
	var b strings.Builder
	fmt.Fprintf(&b, "## Recommandation\nOuvre **%s** (`%s`). %s\n\n", top.Name, top.Path, top.Reason)
	b.WriteString("## Résumé\n")
	if top.Excerpt != "" {
		b.WriteString(excerptSentences(top.Excerpt, 4, 700))
	} else if top.Type == "directory" {
		b.WriteString("C’est un dossier, sans texte à résumer. Ouvre-le pour parcourir les fichiers.")
	} else {
		b.WriteString("Le texte de ce fichier n’a pas pu être extrait (PDF scanné, format fermé ou fichier trop lourd). Ouvre-le pour le lire : je n’invente pas son contenu.")
	}
	b.WriteString("\n\n## Points clés\n")
	points := keyPoints(top.Excerpt, 5)
	if len(points) == 0 {
		b.WriteString("- Lecture automatique indisponible pour ce fichier\n")
	} else {
		for _, point := range points {
			b.WriteString("- ")
			b.WriteString(point)
			b.WriteByte('\n')
		}
	}
	b.WriteString("\n## À ouvrir\n`")
	b.WriteString(top.Path)
	b.WriteString("`\n")
	if note != "" {
		b.WriteString("\n")
		b.WriteString(note)
		b.WriteByte('\n')
	}
	return b.String()
}

func ensureStructure(answer string, hits []chat.Hit) string {
	answer = strings.TrimSpace(answer)
	if answer == "" {
		return localAnswer(hits, "")
	}
	if strings.Contains(answer, "## ") {
		return answer
	}
	var b strings.Builder
	b.WriteString("## Réponse\n")
	b.WriteString(answer)
	if len(hits) > 0 {
		b.WriteString("\n\n## À ouvrir\n`")
		b.WriteString(hits[0].Path)
		b.WriteString("`\n")
	}
	return b.String()
}

func excerptSentences(excerpt string, count, limit int) string {
	parts := splitSentences(excerpt)
	if len(parts) == 0 {
		return chat.Clip(excerpt, limit)
	}
	if len(parts) > count {
		parts = parts[:count]
	}
	return chat.Clip(strings.Join(parts, " "), limit)
}

func keyPoints(excerpt string, count int) []string {
	parts := splitSentences(excerpt)
	points := make([]string, 0, count)
	for _, part := range parts {
		if len([]rune(part)) < 40 {
			continue
		}
		points = append(points, chat.Clip(part, 180))
		if len(points) == count {
			break
		}
	}
	if len(points) == 0 && strings.TrimSpace(excerpt) != "" {
		return []string{chat.Clip(strings.TrimSpace(excerpt), 180)}
	}
	return points
}

func splitSentences(excerpt string) []string {
	excerpt = strings.TrimSpace(excerpt)
	if excerpt == "" {
		return nil
	}
	var parts []string
	var current strings.Builder
	for _, r := range excerpt {
		current.WriteRune(r)
		if r == '.' || r == '!' || r == '?' || r == '…' {
			if text := strings.TrimSpace(current.String()); text != "" {
				parts = append(parts, text)
			}
			current.Reset()
		}
	}
	if text := strings.TrimSpace(current.String()); text != "" {
		parts = append(parts, text)
	}
	return parts
}

func (s *Server) downloadChatPrefix(ctx context.Context, filePath string, maxBytes int64) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, catalog.BuildHfFileURL(s.cfg.HFOrigin, s.cfg.BucketID, filePath), nil)
	if err != nil {
		return nil, err
	}
	request.Header = s.hfHeaders("*/*")
	response, err := s.do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return nil, catalog.Error(http.StatusNotFound, "Document introuvable.")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, catalog.Error(http.StatusBadGateway, "Lecture du document impossible.")
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxBytes))
	if err != nil {
		return nil, err
	}
	if len(payload) == 0 {
		return nil, catalog.Error(http.StatusUnprocessableEntity, "Document vide.")
	}
	return payload, nil
}

func promoteMentioned(answer string, hits []chat.Hit) []chat.Hit {
	if len(hits) < 2 || answer == "" {
		return hits
	}
	folded := strings.ToLower(answer)
	best := -1
	pos := len(folded) + 1
	for i, hit := range hits {
		for _, needle := range []string{strings.ToLower(hit.Path), strings.ToLower(hit.Name)} {
			if needle == "" {
				continue
			}
			at := strings.Index(folded, needle)
			if at >= 0 && at < pos {
				pos = at
				best = i
			}
		}
	}
	if best <= 0 {
		return hits
	}
	promoted := make([]chat.Hit, 0, len(hits))
	promoted = append(promoted, hits[best])
	promoted = append(promoted, hits[:best]...)
	return append(promoted, hits[best+1:]...)
}

func publicHits(hits []chat.Hit) []chat.Hit {
	if hits == nil {
		return []chat.Hit{}
	}
	out := make([]chat.Hit, len(hits))
	for i, hit := range hits {
		hit.Excerpt = chat.Clip(hit.Excerpt, chatCardRunes)
		out[i] = hit
	}
	return out
}

func anyRead(hits []chat.Hit) bool {
	for _, hit := range hits {
		if hit.Read {
			return true
		}
	}
	return false
}

func writeSSE(w http.ResponseWriter, event string, payload any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, body); err != nil {
		return err
	}
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
	return nil
}
