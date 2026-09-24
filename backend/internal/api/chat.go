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
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"enise-docs/backend/internal/appwrite"
	"enise-docs/backend/internal/cache"
	"enise-docs/backend/internal/catalog"
	"enise-docs/backend/internal/chat"
)

// Les modèles qui raisonnent écrivent d’abord leur réflexion, puis la
// réponse : le budget doit couvrir les deux, sinon il ne reste plus rien à
// afficher (finish_reason « length », contenu vide).
const (
	chatReadLimit      = 8 << 20
	chatReadableMax    = 25 << 20
	chatBodyLimit      = 384 << 10
	chatRateLimit      = 30
	chatExcerptWait    = 30 * time.Second
	chatAnswerWait     = 150 * time.Second
	chatAttemptWait    = 90 * time.Second
	chatExcerptRunes   = 9000
	chatCardRunes      = 280
	chatPromptRunes    = 3500
	chatSynthesisRunes = 2600
	chatPairRunes      = 1400
	chatAnswerRunes    = 9000
	chatFallbackTokens = 4096
	chatDeepTokens     = 8192
	chatMaxTokens      = 16384
	defaultChatModel   = "meta/llama-3.1-8b-instruct"
	nvidiaMissingNote  = "L’analyse rédigée par l’IA n’est pas activée sur ce serveur. Tu peux déjà ouvrir les documents proposés."
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

type chatModel struct {
	ID        string
	Label     string
	Reasoning bool
}

// chatModelCatalog liste les modèles du sélecteur. Reasoning marque les
// modèles qui réfléchissent avant d’écrire : le serveur leur donne un budget
// de jetons plus large et encadre leur réflexion pour qu’il reste de la
// place pour la réponse visible.
var chatModelCatalog = map[string][]chatModel{
	"cloudflare": {
		{ID: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", Label: "Llama 3.3 70B (rapide)"},
		{ID: "@cf/meta/llama-4-scout-17b-16e-instruct", Label: "Llama 4 Scout"},
		{ID: "@cf/meta/llama-3.1-8b-instruct-fast", Label: "Llama 3.1 8B (économe)"},
		{ID: "@cf/nvidia/nemotron-3-120b-a12b", Label: "Nemotron 3 Super", Reasoning: true},
		{ID: "@cf/zai-org/glm-4.7-flash", Label: "GLM-4.7 Flash", Reasoning: true},
		{ID: "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", Label: "DeepSeek R1 32B", Reasoning: true},
	},
	"openrouter": {
		{ID: "openai/gpt-oss-120b:free", Label: "GPT-OSS 120B", Reasoning: true},
		{ID: "nvidia/nemotron-3-ultra-550b-a55b:free", Label: "Nemotron 3 Ultra", Reasoning: true},
		{ID: "nvidia/nemotron-3-super-120b-a12b:free", Label: "Nemotron 3 Super", Reasoning: true},
		{ID: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", Label: "Nemotron Nano Omni", Reasoning: true},
		{ID: "poolside/laguna-m.1:free", Label: "Laguna M.1", Reasoning: true},
		{ID: "cohere/north-mini-code:free", Label: "North Mini Code", Reasoning: true},
	},
	"nvidia": {
		{ID: "nvidia/nemotron-3-ultra-550b-a55b", Label: "Nemotron 3 Ultra", Reasoning: true},
		{ID: "nvidia/nemotron-3-super-120b-a12b", Label: "Nemotron 3 Super", Reasoning: true},
		{ID: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", Label: "Nemotron Nano Omni", Reasoning: true},
		{ID: "openai/gpt-oss-120b", Label: "GPT-OSS 120B", Reasoning: true},
		{ID: "deepseek-ai/deepseek-v4-pro", Label: "DeepSeek V4 Pro", Reasoning: true},
		{ID: "z-ai/glm-5.1", Label: "GLM-5.1", Reasoning: true},
	},
	"opencode": {
		{ID: "nemotron-3-ultra-free", Label: "Nemotron 3 Ultra", Reasoning: true},
		{ID: "nemotron-3.5-lightning-free", Label: "Nemotron 3.5 Lightning", Reasoning: true},
		{ID: "deepseek-v4-flash-free", Label: "DeepSeek V4 Flash", Reasoning: true},
		{ID: "mimo-v2.5-free", Label: "MiMo-V2.5", Reasoning: true},
		{ID: "minimax-m2.5-free", Label: "MiniMax M2.5", Reasoning: true},
		{ID: "big-pickle", Label: "Big Pickle", Reasoning: true},
	},
}

func (s *Server) chatProviders() []map[string]any {
	ready := func(values ...string) bool {
		for _, value := range values {
			if strings.TrimSpace(value) == "" {
				return false
			}
		}
		return true
	}
	definitions := []struct {
		id      string
		label   string
		model   string
		enabled bool
	}{
		// Workers AI exige le jeton ET l’identifiant de compte.
		{"cloudflare", "Cloudflare", s.cfg.CloudflareAIModel, ready(s.cfg.CloudflareAIToken, s.cfg.CloudflareAccountID)},
		{"openrouter", "OpenRouter", s.cfg.OpenRouterModel, ready(s.cfg.OpenRouterAPIKey)},
		{"nvidia", "NVIDIA", s.cfg.NvidiaModel, ready(s.cfg.NvidiaAPIKey)},
		{"opencode", "OpenCode", s.cfg.OpenCodeModel, ready(s.cfg.OpenCodeAPIKey)},
	}
	out := make([]map[string]any, 0, len(definitions))
	for _, definition := range definitions {
		models := make([]map[string]any, 0, len(chatModelCatalog[definition.id]))
		for _, model := range chatModelCatalog[definition.id] {
			models = append(models, map[string]any{
				"id":        model.ID,
				"label":     model.Label,
				"free":      true,
				"reasoning": model.Reasoning,
			})
		}
		out = append(out, map[string]any{
			"id":      definition.id,
			"label":   definition.label,
			"model":   definition.model,
			"enabled": definition.enabled,
			"models":  models,
		})
	}
	return out
}

// modelIsReasoning dit si le modèle choisi réfléchit avant de répondre.
func modelIsReasoning(providerID, model string) bool {
	for _, entry := range chatModelCatalog[providerID] {
		if entry.ID == model {
			return entry.Reasoning
		}
	}
	return false
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
		s.finishChat(w, r, body.ConversationID, message, chatDraft{answer: answer, engine: "local"}, contextPath, nil)
		return nil
	}
	if len(items) == 0 {
		answer := "La bibliothèque n’est pas encore indexée. Réessaie dans un instant."
		_ = writeSSE(w, "delta", map[string]string{"text": answer})
		s.finishChat(w, r, body.ConversationID, message, chatDraft{answer: answer, engine: "local"}, contextPath, nil)
		return nil
	}

	profile := chat.QuestionProfile(message)
	rankLimit := 6
	if profile.Synthesis {
		rankLimit = profile.MaxDocs
	}
	hits := chat.ExpandForReading(items, chat.Rank(items, message, contextPath, rankLimit), rankLimit)
	// « comment se structure l’examen » demande plusieurs annales : on ajoute
	// les voisins du meilleur dossier avant de lire les extraits.
	if profile.Synthesis {
		if neighbours := chat.RelatedDocuments(items, hits, profile.MaxDocs-len(hits)); len(neighbours) > 0 {
			hits = append(hits, neighbours...)
		}
	}
	if err := writeSSE(w, "sources", map[string]any{"documents": publicHits(hits)}); err != nil {
		return nil
	}
	s.enrichHits(r.Context(), hits, profile.MaxRead)
	if anyRead(hits) {
		_ = writeSSE(w, "sources", map[string]any{"documents": publicHits(hits)})
	}

	draft := s.composeAnswer(r.Context(), w, message, contextPath, sanitizeHistory(body.History, message), hits, body.Provider, body.Model, profile)
	s.finishChat(w, r, body.ConversationID, message, draft, contextPath, hits)
	return nil
}

func (s *Server) finishChat(w http.ResponseWriter, r *http.Request, conversationID, question string, draft chatDraft, contextPath string, hits []chat.Hit) {
	hits = promoteMentioned(draft.answer, hits)
	saved := s.rememberChat(r, conversationID, question, draft.answer, contextPath, hits)
	_ = writeSSE(w, "done", map[string]any{
		"answer":         draft.answer,
		"engine":         draft.engine,
		"model":          draft.model,
		"notice":         draft.note,
		"degraded":       draft.degraded,
		"attempted":      draft.attempted,
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

// enrichHits lit les extraits de plusieurs documents. Une question de
// synthèse en lit cinq : un seul extrait ne permet pas de comparer des
// annales entre elles.
func (s *Server) enrichHits(ctx context.Context, hits []chat.Hit, maxRead int) {
	if maxRead <= 0 {
		maxRead = 2
	}
	ctx, cancel := context.WithTimeout(ctx, chatExcerptWait)
	defer cancel()
	var wg sync.WaitGroup
	sem := make(chan struct{}, 3)
	reading := 0
	for i := range hits {
		if reading >= maxRead {
			break
		}
		if !chat.Readable(hits[i].Path, hits[i].Type, hits[i].Size, chatReadableMax) {
			continue
		}
		reading++
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

// chatDraft est la réponse rédigée par un moteur, ou le repli local quand
// aucun moteur n’aboutit.
type chatDraft struct {
	answer    string
	engine    string
	model     string
	attempted string // moteur essayé quand la rédaction est retombée en local
	note      string
	degraded  bool // vrai quand un moteur a échoué : relancer peut réussir
}

func (s *Server) composeAnswer(ctx context.Context, w http.ResponseWriter, message, contextPath string, history []chatTurn, hits []chat.Hit, providerID, modelOverride string, profile chat.Profile) chatDraft {
	providers := s.chatCandidates(providerID, modelOverride)
	if len(hits) == 0 {
		answer := "Je n’ai pas trouvé de document qui corresponde. Essaie avec le nom d’un cours, une année (3A, 4A, 5A) ou TOEIC."
		_ = writeSSE(w, "delta", map[string]string{"text": answer})
		return chatDraft{answer: answer, engine: "local"}
	}
	if len(providers) == 0 {
		answer := localAnswer(hits, nvidiaMissingNote)
		_ = writeSSE(w, "delta", map[string]string{"text": answer})
		return chatDraft{answer: answer, engine: "local", note: nvidiaMissingNote}
	}
	if profile.Synthesis && !anyRead(hits) {
		note := "Je n’ai pas pu lire le texte de ces documents (PDF scannés, images ou formats fermés) : sans texte, je ne peux pas décrire leur structure sans inventer. Ouvre-les plutôt ci-dessus."
		answer := localAnswer(hits, note)
		_ = writeSSE(w, "delta", map[string]string{"text": answer})
		return chatDraft{answer: answer, engine: "local", note: note}
	}

	deadline := time.Now().Add(s.chatAnswerBudget())
	var lastErr error
	attemptedID := ""
	attemptedModel := ""
	for _, provider := range providers {
		remaining := time.Until(deadline)
		if remaining < 20*time.Second {
			if lastErr == nil {
				lastErr = &chatCompletionError{kind: "timeout", provider: "Le modèle"}
			}
			break
		}
		attemptedID = provider.id
		attemptedModel = provider.model
		draft, err := s.draftWithProvider(ctx, w, message, contextPath, history, hits, provider, profile, remaining)
		if err == nil {
			return draft
		}
		log.Printf("chat %s/%s: %v", provider.id, provider.model, err)
		lastErr = err
	}
	note := chatFailureNote(lastErr)
	answer := localAnswer(hits, note)
	_ = writeSSE(w, "delta", map[string]string{"text": answer})
	return chatDraft{
		answer:    answer,
		engine:    "local",
		model:     attemptedModel,
		attempted: attemptedID,
		note:      note,
		degraded:  true,
	}
}

// draftWithProvider interroge un moteur. Si le modèle a épuisé son budget de
// jetons en réfléchissant, une seconde tentative lui en laisse davantage
// avant de passer au moteur suivant.
func (s *Server) draftWithProvider(ctx context.Context, w http.ResponseWriter, message, contextPath string, history []chatTurn, hits []chat.Hit, provider *chatProvider, profile chat.Profile, budget time.Duration) (chatDraft, error) {
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		reasoning := modelIsReasoning(provider.id, provider.model)
		tokens := s.chatTokens(profile)
		if attempt > 0 {
			// Le modèle a réfléchi au lieu d’écrire : on double la place.
			tokens *= 2
		}
		// « reasoning » est un paramètre OpenRouter : ailleurs, un fournisseur
		// qui ne le connaît pas pourrait répondre 400.
		effort := ""
		if (reasoning || attempt > 0) && provider.id == "openrouter" {
			switch {
			case attempt > 0:
				effort = "low"
			case profile.Synthesis:
				effort = "medium"
			default:
				effort = "low"
			}
		}
		if tokens > chatMaxTokens {
			tokens = chatMaxTokens
		}
		attemptBudget := budget
		if attemptBudget > chatAttemptWait {
			attemptBudget = chatAttemptWait
		}
		attemptCtx, cancel := context.WithTimeout(ctx, attemptBudget)
		var streamed strings.Builder
		stats := &completionStats{}
		announced := false
		err := s.streamChatCompletion(attemptCtx, provider, s.nvidiaMessages(message, contextPath, history, hits, profile), completionOptions{
			maxTokens: tokens,
			effort:    effort,
		}, func(delta string) error {
			streamed.WriteString(delta)
			return writeSSE(w, "delta", map[string]string{"text": delta})
		}, func() {
			if announced {
				return
			}
			announced = true
			_ = writeSSE(w, "thinking", map[string]string{"text": "Le modèle réfléchit…"})
		}, stats)
		cancel()
		log.Printf("chat %s/%s tentative %d: %d caractères, %d segments de réflexion, finish=%q, err=%v",
			provider.id, provider.model, attempt+1, streamed.Len(), stats.thinking, stats.finish, err)
		if err == nil && strings.TrimSpace(streamed.String()) == "" {
			err = &chatCompletionError{kind: "empty", provider: provider.label, finish: stats.finish}
		}
		if err == nil {
			return chatDraft{answer: ensureStructure(streamed.String(), hits), engine: provider.id, model: provider.model}, nil
		}
		lastErr = err
		var completionErr *chatCompletionError
		if errors.As(err, &completionErr) && completionErr != nil {
			if completionErr.kind == "truncated" {
				continue
			}
			// Modèle inconnu du fournisseur : on retombe sur son modèle par défaut.
			if completionErr.status == http.StatusNotFound && provider.fallbackModel != "" && provider.fallbackModel != provider.model {
				log.Printf("chat %s: modèle %s introuvable, repli sur %s", provider.id, provider.model, provider.fallbackModel)
				provider.model = provider.fallbackModel
				continue
			}
		}
		break
	}
	return chatDraft{}, lastErr
}

func (s *Server) chatAnswerBudget() time.Duration {
	if s.cfg.ChatAnswerTimeout > 0 {
		return s.cfg.ChatAnswerTimeout
	}
	return chatAnswerWait
}

func (s *Server) chatTokens(profile chat.Profile) int {
	if profile.Synthesis {
		if s.cfg.ChatDeepTokens > 0 {
			return s.cfg.ChatDeepTokens
		}
		return chatDeepTokens
	}
	if s.cfg.ChatMaxTokens > 0 {
		return s.cfg.ChatMaxTokens
	}
	return chatFallbackTokens
}

type chatProvider struct {
	id            string
	label         string
	baseURL       string
	apiKey        string
	model         string
	fallbackModel string // modèle du .dev.vars, utilisé si le modèle choisi est introuvable
}

// chatCandidates renvoie les moteurs prêts, le moteur demandé d’abord. Si le
// premier échoue (clé refusée, quota, modèle injoignable), le suivant prend
// le relais au lieu d’abandonner la question.
func (s *Server) chatCandidates(providerID, modelOverride string) []*chatProvider {
	providerID = strings.ToLower(strings.TrimSpace(providerID))
	modelOverride = sanitizeModel(modelOverride)
	all := []*chatProvider{
		{
			id: "cloudflare", label: "Cloudflare",
			baseURL: s.cfg.CloudflareAIBase, apiKey: s.cfg.CloudflareAIToken,
			model:         firstNonEmpty(modelOverride, s.cfg.CloudflareAIModel),
			fallbackModel: s.cfg.CloudflareAIModel,
		},
		{
			id: "openrouter", label: "OpenRouter",
			baseURL: s.cfg.OpenRouterAPIBase, apiKey: s.cfg.OpenRouterAPIKey,
			model:         firstNonEmpty(modelOverride, s.cfg.OpenRouterModel),
			fallbackModel: s.cfg.OpenRouterModel,
		},
		{
			id: "nvidia", label: "NVIDIA",
			baseURL: s.cfg.NvidiaAPIBase, apiKey: s.cfg.NvidiaAPIKey,
			model:         firstNonEmpty(modelOverride, s.cfg.NvidiaModel),
			fallbackModel: s.cfg.NvidiaModel,
		},
		{
			id: "opencode", label: "OpenCode",
			baseURL: s.cfg.OpenCodeAPIBase, apiKey: s.cfg.OpenCodeAPIKey,
			model:         firstNonEmpty(modelOverride, s.cfg.OpenCodeModel),
			fallbackModel: s.cfg.OpenCodeModel,
		},
	}
	ready := make([]*chatProvider, 0, len(all))
	var requested *chatProvider
	for _, candidate := range all {
		if strings.TrimSpace(candidate.apiKey) == "" || candidate.model == "" {
			continue
		}
		if providerID != "" && providerID == candidate.id {
			requested = candidate
			continue
		}
		ready = append(ready, candidate)
	}
	if requested != nil {
		return append([]*chatProvider{requested}, ready...)
	}
	return ready
}

func (s *Server) nvidiaMessages(message, contextPath string, history []chatTurn, hits []chat.Hit, profile chat.Profile) []nvidiaMessage {
	messages := make([]nvidiaMessage, 0, len(history)+2)
	if profile.Synthesis {
		messages = append(messages, nvidiaMessage{Role: "system", Content: chatSynthesisPrompt})
	} else {
		messages = append(messages, nvidiaMessage{Role: "system", Content: chatSystemPrompt})
	}
	for _, turn := range history {
		messages = append(messages, nvidiaMessage{Role: turn.Role, Content: turn.Content})
	}
	messages = append(messages, nvidiaMessage{Role: "user", Content: documentPrompt(message, contextPath, hits, profile)})
	return messages
}

const chatSystemPrompt = `Tu es l’assistant de la bibliothèque ENISE Docs (Centrale Lyon ENISE).
Tu réponds uniquement à partir des extraits fournis. Tu n’inventes aucun chemin, cours, date, durée ou chiffre.
Si un extrait manque, dis-le : ne décris jamais un document que tu n’as pas lu.

Réponds en français, avec exactement cette structure markdown :

## Recommandation
Une ou deux phrases : quel document ouvrir, et pourquoi il répond à la question.

## Résumé
Un paragraphe de 5 à 8 lignes qui reformule l’extrait du document principal. S’il n’y a pas d’extrait, écris « Texte non extractible » et n’invente rien.

## Points clés
- trois à six puces concrètes, prises dans l’extrait
- si l’extrait manque : une seule puce « Texte non extractible »

## À ouvrir
Le chemin exact du document principal, seul, entre backticks.`

const chatSynthesisPrompt = `Tu es l’assistant de la bibliothèque ENISE Docs (Centrale Lyon ENISE).
La question porte sur une structure, un format ou un déroulement : tu dois croiser PLUSIEURS documents fournis, pas en résumer un seul.
Tu n’inventes rien : aucun chemin, cours, date, durée, coefficient ni barème qui ne figure pas dans les extraits.
Un extrait peut être partiel, tronqué ou absent : dis-le. Ne comble jamais un trou par une supposition, même vraisemblable.

Réponds en français, avec exactement cette structure markdown :

## Recommandation
Une ou deux phrases : le document à ouvrir en premier, et pourquoi il est le plus représentatif.

## Ce que montrent les documents
Un paragraphe de 5 à 8 lignes : ce qui revient dans tous les documents, et ce qui change de l’un à l’autre (année, format, durée, type de questions).

## Structure observée
Une liste numérotée des grandes parties ou étapes, déduite des extraits. Cite entre crochets le nom du document qui illustre chaque partie.

## Points clés
- trois à six puces concrètes, chacune appuyée sur un extrait

## Ce qui reste à vérifier
Une ou deux phrases : ce que les extraits ne permettent pas de trancher, et les documents à ouvrir pour confirmer.

## À ouvrir
Les chemins exacts des documents utilisés, un par ligne, entre backticks.`

func documentPrompt(question, contextPath string, hits []chat.Hit, profile chat.Profile) string {
	var b strings.Builder
	if contextPath == "" {
		b.WriteString("Dossier ouvert : bibliothèque entière\n")
	} else {
		b.WriteString("Dossier ouvert : ")
		b.WriteString(contextPath)
		b.WriteByte('\n')
	}
	if profile.Synthesis {
		b.WriteString("Consigne : question de synthèse. Compare les documents entre eux avant de répondre. Ce qui n’apparaît que dans un seul document doit être signalé comme tel.\n")
	}
	if len(hits) == 0 {
		b.WriteString("Aucun document vérifié.\n")
	} else {
		b.WriteString("Documents vérifiés :\n")
	}
	budget := chatPromptRunes
	if profile.Synthesis && len(hits) > 2 {
		budget = chatSynthesisRunes
	}
	for i, hit := range hits {
		fmt.Fprintf(&b, "%d. %s\n   chemin : `%s`\n   pourquoi : %s\n", i+1, hit.Name, hit.Path, hit.Reason)
		limit := budget
		if !profile.Synthesis && i > 0 {
			limit = chatPairRunes
		}
		if hit.Excerpt != "" {
			b.WriteString("   extrait : ")
			b.WriteString(chat.Clip(hit.Excerpt, limit))
			b.WriteByte('\n')
			continue
		}
		b.WriteString("   extrait : aucun texte lisible (fichier image, PDF scanné, format fermé ou lecture interrompue). Ne résume pas son contenu.\n")
	}
	b.WriteString("Question : ")
	b.WriteString(question)
	return b.String()
}

type completionOptions struct {
	maxTokens int
	effort    string
}

// completionStats garde de quoi diagnostiquer un silence : combien de
// segments de réflexion, quelle raison d’arrêt, combien de caractères utiles.
type completionStats struct {
	thinking int
	chunks   int
	finish   string
}

type completionChunkData struct {
	content  string
	thinking string
	finish   string
}

func (s *Server) streamChatCompletion(ctx context.Context, provider *chatProvider, messages []nvidiaMessage, options completionOptions, onDelta func(string) error, onThinking func(), stats *completionStats) error {
	if provider == nil {
		return &chatCompletionError{kind: "empty", provider: "aucun moteur"}
	}
	if stats == nil {
		stats = &completionStats{}
	}
	endpoint, err := s.completionEndpoint(provider)
	if err != nil {
		return &chatCompletionError{kind: "network", provider: provider.label, message: err.Error()}
	}
	payload := map[string]any{
		"messages":    messages,
		"temperature": 0.2,
		"stream":      true,
	}
	if options.maxTokens > 0 {
		payload["max_tokens"] = options.maxTokens
	}
	if provider.id == "cloudflare" {
		// Workers AI porte le modèle dans l’URL et encadre la réflexion avec
		// « reasoning_effort » (pas l’objet « reasoning » d’OpenRouter).
		if options.effort != "" {
			payload["reasoning_effort"] = options.effort
		}
	} else {
		payload["model"] = provider.model
		// Encadrer la réflexion : sans ça, un modèle qui raisonne peut consommer
		// tout le budget en jetons de réflexion et ne renvoyer aucun contenu.
		if options.effort != "" {
			payload["reasoning"] = map[string]any{"effort": options.effort}
		}
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return &chatCompletionError{kind: "network", provider: provider.label, message: err.Error()}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return &chatCompletionError{kind: "network", provider: provider.label, message: err.Error()}
	}
	request.Header.Set("Authorization", "Bearer "+provider.apiKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "text/event-stream, application/json")
	request.Header.Set("User-Agent", "enise-docs-go")
	if provider.id == "openrouter" {
		request.Header.Set("HTTP-Referer", "https://enise-docs.local")
		request.Header.Set("X-Title", "ENISE Docs")
	}
	response, err := s.llmClient.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return &chatCompletionError{kind: "timeout", provider: provider.label, message: ctx.Err().Error()}
		}
		log.Printf("%s chat injoignable: %v", provider.id, err)
		return &chatCompletionError{kind: "network", provider: provider.label, message: err.Error()}
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		detail := readLLMError(response.Body)
		log.Printf("%s chat status %d %s", provider.id, response.StatusCode, detail)
		return &chatCompletionError{kind: "status", provider: provider.label, status: response.StatusCode, message: detail}
	}
	contentType := response.Header.Get("Content-Type")
	if strings.Contains(contentType, "application/json") && !strings.Contains(contentType, "text/event-stream") {
		return readCompletionJSON(response.Body, onDelta, stats)
	}
	return readCompletionStream(response.Body, onDelta, onThinking, stats)
}

// chatCompletionError décrit un échec de rédaction. Le message affiché en
// dépend : budget épuisé, délai dépassé, clé refusée ou panne réseau ne se
// réparent pas de la même façon.
type chatCompletionError struct {
	kind     string // "timeout", "truncated", "status", "network", "upstream", "empty"
	provider string
	status   int
	message  string
	finish   string
}

func (e *chatCompletionError) Error() string {
	if e == nil {
		return ""
	}
	var b strings.Builder
	b.WriteString("llm ")
	b.WriteString(e.kind)
	if e.provider != "" {
		b.WriteByte(' ')
		b.WriteString(e.provider)
	}
	if e.status != 0 {
		fmt.Fprintf(&b, " status %d", e.status)
	}
	if e.finish != "" {
		b.WriteString(" finish ")
		b.WriteString(e.finish)
	}
	if e.message != "" {
		b.WriteString(": ")
		b.WriteString(e.message)
	}
	return b.String()
}

func chatFailureNote(err error) string {
	var completionErr *chatCompletionError
	if errors.As(err, &completionErr) && completionErr != nil {
		label := completionErr.provider
		if label == "" {
			label = "Le modèle"
		}
		switch {
		case completionErr.kind == "truncated":
			return label + " a réfléchi jusqu’à épuiser son budget de jetons, sans écrire la moindre réponse. Essaie un autre modèle du menu, ou une question plus courte. Les documents ci-dessus viennent quand même de la bibliothèque."
		case completionErr.kind == "timeout":
			return label + " n’a pas répondu à temps : la rédaction a été interrompue. Réessaie, ou choisis un modèle plus rapide. Les documents ci-dessus viennent quand même de la bibliothèque."
		case completionErr.status == http.StatusUnauthorized, completionErr.status == http.StatusForbidden:
			return "La clé " + label + " a été refusée. Les documents ci-dessus viennent quand même de la bibliothèque."
		case completionErr.status == http.StatusTooManyRequests:
			return label + " limite le débit pour le moment. Réessaie dans un instant. Les documents ci-dessus viennent quand même de la bibliothèque."
		case completionErr.status == http.StatusNotFound:
			return "Ce modèle est introuvable chez " + label + ". Choisis-en un autre dans le menu. Les documents ci-dessus viennent quand même de la bibliothèque."
		case completionErr.kind == "upstream" && completionErr.message != "":
			return label + " a renvoyé une erreur : " + completionErr.message + " Les documents ci-dessus viennent quand même de la bibliothèque."
		}
	}
	return "La rédaction automatique n’a pas abouti. Les documents ci-dessus viennent quand même de la bibliothèque."
}

func readLLMError(body io.Reader) string {
	payload, err := io.ReadAll(io.LimitReader(body, 4<<10))
	if err != nil {
		return ""
	}
	var decoded struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return chat.Clip(strings.TrimSpace(string(payload)), 160)
	}
	if decoded.Error.Message != "" {
		return chat.Clip(decoded.Error.Message, 200)
	}
	if decoded.Message != "" {
		return chat.Clip(decoded.Message, 200)
	}
	return chat.Clip(strings.TrimSpace(string(payload)), 160)
}

func readCompletionJSON(body io.Reader, onDelta func(string) error, stats *completionStats) error {
	payload, err := io.ReadAll(io.LimitReader(body, 1<<20))
	if err != nil {
		return &chatCompletionError{kind: "network", message: err.Error()}
	}
	chunk := completionChunk(payload)
	stats.finish = chunk.finish
	stats.chunks++
	if chunk.thinking != "" {
		stats.thinking++
	}
	if chunk.content == "" {
		return &chatCompletionError{kind: "empty", finish: chunk.finish}
	}
	return onDelta(chat.Clip(chunk.content, chatAnswerRunes))
}

func readCompletionStream(body io.Reader, onDelta func(string) error, onThinking func(), stats *completionStats) error {
	if stats == nil {
		stats = &completionStats{}
	}
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
	written := 0
	announced := false
	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), "\r")
		if line == "" || strings.HasPrefix(line, ":") || !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" {
			continue
		}
		if data == "[DONE]" {
			return finishStream(stats, written)
		}
		if strings.HasPrefix(data, "{") && strings.Contains(data, "\"error\"") && !strings.Contains(data, "\"choices\"") {
			return &chatCompletionError{kind: "upstream", message: readLLMError(strings.NewReader(data))}
		}
		chunk := completionChunk([]byte(data))
		stats.chunks++
		if chunk.finish != "" {
			stats.finish = chunk.finish
		}
		if chunk.thinking != "" {
			stats.thinking++
			if !announced && onThinking != nil {
				announced = true
				onThinking()
			}
		}
		text := chunk.content
		if text == "" {
			continue
		}
		if written+len([]rune(text)) > chatAnswerRunes {
			text = chat.Clip(text, chatAnswerRunes-written)
		}
		if text == "" {
			return finishStream(stats, written)
		}
		if err := onDelta(text); err != nil {
			return err
		}
		written += len([]rune(text))
		if written >= chatAnswerRunes {
			return finishStream(stats, written)
		}
	}
	if err := scanner.Err(); err != nil {
		return &chatCompletionError{kind: "network", message: err.Error()}
	}
	return finishStream(stats, written)
}

// finishStream transforme un silence en erreur exploitable : un flux qui
// s’arrête sur « length » sans contenu a été tronqué par le budget de jetons,
// il ne s’agit pas d’une réponse vide.
func finishStream(stats *completionStats, written int) error {
	if written > 0 {
		return nil
	}
	finish := ""
	if stats != nil {
		finish = stats.finish
	}
	if finish == "length" {
		return &chatCompletionError{kind: "truncated", finish: finish}
	}
	return &chatCompletionError{kind: "empty", finish: finish}
}

// chunkChoice est un choix de complétion au format OpenAI. Workers AI
// l’utilise aussi, parfois enveloppé dans « result ».
type chunkChoice struct {
	Delta struct {
		Content          json.RawMessage `json:"content"`
		ReasoningContent json.RawMessage `json:"reasoning_content"`
		Reasoning        json.RawMessage `json:"reasoning"`
	} `json:"delta"`
	Message struct {
		Content          json.RawMessage `json:"content"`
		ReasoningContent json.RawMessage `json:"reasoning_content"`
		Reasoning        json.RawMessage `json:"reasoning"`
	} `json:"message"`
	Text   string `json:"text"`
	Finish string `json:"finish_reason"`
}

// completionChunk lit un morceau de réponse, quel que soit le moteur :
// format OpenAI, Workers AI enrobé dans « result », ou flux SSE Workers AI
// (« response »). Les modèles qui raisonnent écrivent leur réflexion dans
// « reasoning_content » ou « reasoning » : ne pas les lire faisait croire à
// un flux vide alors que le modèle travaillait.
func completionChunk(payload []byte) completionChunkData {
	var chunk struct {
		Choices []chunkChoice `json:"choices"`
		Result  struct {
			Response string        `json:"response"`
			Choices  []chunkChoice `json:"choices"`
		} `json:"result"`
		Response string `json:"response"`
	}
	if err := json.Unmarshal(payload, &chunk); err != nil {
		return completionChunkData{}
	}
	out := completionChunkData{}
	if len(chunk.Choices) > 0 {
		out = choiceChunk(chunk.Choices[0])
	}
	if out.content == "" && len(chunk.Result.Choices) > 0 {
		merged := choiceChunk(chunk.Result.Choices[0])
		if out.finish == "" {
			out.finish = merged.finish
		}
		if out.thinking == "" {
			out.thinking = merged.thinking
		}
		out.content = merged.content
	}
	if out.content == "" {
		switch {
		case chunk.Result.Response != "":
			out.content = chunk.Result.Response
		case chunk.Response != "":
			out.content = chunk.Response
		}
	}
	return out
}

func choiceChunk(choice chunkChoice) completionChunkData {
	out := completionChunkData{finish: choice.Finish, content: choice.Text}
	if value := decodeContent(choice.Delta.Content); value != "" {
		out.content = value
	}
	if value := decodeContent(choice.Message.Content); value != "" {
		out.content = value
	}
	for _, raw := range []json.RawMessage{choice.Delta.ReasoningContent, choice.Delta.Reasoning, choice.Message.ReasoningContent, choice.Message.Reasoning} {
		if value := decodeContent(raw); value != "" {
			out.thinking = value
			break
		}
	}
	return out
}

// decodeContent accepte une chaîne simple, ou une liste de blocs : certains
// fournisseurs renvoient « content » sous forme de tableau.
func decodeContent(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return ""
	}
	var text string
	if err := json.Unmarshal(trimmed, &text); err == nil {
		return text
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(trimmed, &blocks); err != nil {
		return ""
	}
	var b strings.Builder
	for _, block := range blocks {
		if block.Text != "" {
			b.WriteString(block.Text)
		}
	}
	return b.String()
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
		case r == '/' || r == '.' || r == '_' || r == '-' || r == ':' || r == '@':
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
		case r == '/' || r == '.' || r == '_' || r == '-' || r == ':' || r == '@':
		default:
			return defaultChatModel
		}
	}
	return model
}

func (s *Server) nvidiaEndpoint() (string, error) {
	return chatEndpoint(s.cfg.NvidiaAPIBase, "NVIDIA")
}

// completionEndpoint choisit l’URL selon le moteur : Workers AI expose
// /accounts/<compte>/ai/run/<modèle>, les autres suivent l’API OpenAI.
func (s *Server) completionEndpoint(provider *chatProvider) (string, error) {
	if provider.id == "cloudflare" {
		return workersAIEndpoint(s.cfg.CloudflareAIBase, s.cfg.CloudflareAccountID, provider.model)
	}
	return chatEndpoint(provider.baseURL, provider.label)
}

// workersAIEndpoint construit l’URL de l’API REST Workers AI. Le modèle
// contient des barres obliques (« @cf/meta/llama… ») : chaque segment est
// échappé séparément pour rester un chemin valide.
func workersAIEndpoint(rawBase, accountID, model string) (string, error) {
	if strings.TrimSpace(accountID) == "" {
		return "", fmt.Errorf("CLOUDFLARE_ACCOUNT_ID manquant")
	}
	model = strings.Trim(strings.TrimSpace(model), "/")
	if model == "" {
		return "", fmt.Errorf("modèle Cloudflare manquant")
	}
	base := strings.TrimRight(strings.TrimSpace(rawBase), "/")
	if base == "" {
		base = "https://api.cloudflare.com/client/v4"
	}
	segments := strings.Split(model, "/")
	for i, segment := range segments {
		segments[i] = url.PathEscape(strings.TrimSpace(segment))
	}
	target := base + "/accounts/" + url.PathEscape(strings.TrimSpace(accountID)) + "/ai/run/" + strings.Join(segments, "/")
	request, err := http.NewRequest(http.MethodGet, target, nil)
	if err != nil || request.URL == nil || request.URL.Host == "" {
		return "", fmt.Errorf("origine Cloudflare invalide")
	}
	if request.URL.Scheme != "https" {
		return "", fmt.Errorf("CLOUDFLARE_API_BASE doit être en HTTPS")
	}
	return request.URL.String(), nil
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

var boldHeading = regexp.MustCompile(`^\s*\*\*([^*]{2,48})\*\*\s*:?\s*$`)

// normalizeHeadings transforme les titres en gras (« **Résumé** ») en titres
// markdown. Beaucoup de modèles n’écrivent jamais les dièses : sans ça, la
// réponse arrive d’un seul bloc, sans structure exploitable.
func normalizeHeadings(answer string) string {
	lines := strings.Split(answer, "\n")
	for i, line := range lines {
		match := boldHeading.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		title := strings.TrimSpace(match[1])
		if title == "" {
			continue
		}
		lines[i] = "## " + title
	}
	return strings.Join(lines, "\n")
}

func ensureStructure(answer string, hits []chat.Hit) string {
	answer = normalizeHeadings(strings.TrimSpace(answer))
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
