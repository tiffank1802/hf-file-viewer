package appwrite

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"
)

const (
	chatTitleRunes   = 160
	chatPreviewRunes = 160
	chatBodyRunes    = 8000
	chatSourcesRunes = 2000
	chatPathRunes    = 512
	chatListLimit    = 30
	chatMessageLimit = 80
)

// ChatConversation est l'en-tête d'un fil, sans le texte des messages.
type ChatConversation struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Preview     string `json:"preview"`
	ContextPath string `json:"contextPath,omitempty"`
}

// ChatMessage est un tour utilisateur ou assistant.
type ChatMessage struct {
	ID             string       `json:"id"`
	ConversationID string       `json:"conversationId"`
	Role           string       `json:"role"`
	Text           string       `json:"text"`
	Seq            int          `json:"seq"`
	Sources        []ChatSource `json:"documents,omitempty"`
}

// ChatSource est un document cité, assez court pour tenir dans la ligne.
type ChatSource struct {
	Path string `json:"path"`
	Name string `json:"name,omitempty"`
	Type string `json:"type,omitempty"`
}

// HasChats dit si les deux tables de conversation peuvent être appelées.
func (c *Client) HasChats() bool {
	return c.HasDatabase() &&
		ValidID(firstNonEmpty(c.ConversationsTable, "conversations")) &&
		ValidID(firstNonEmpty(c.MessagesTable, "messages"))
}

// ListChatConversations lit les fils du compte, du plus récent au plus ancien.
func (c *Client) ListChatConversations(ctx context.Context, session, userID string) ([]ChatConversation, error) {
	if !c.HasChats() || !ValidID(userID) {
		return nil, &APIError{Status: http.StatusServiceUnavailable, Type: "not_configured"}
	}
	queries := []appwriteQuery{
		{Method: "equal", Attribute: "userId", Values: []any{userID}},
		{Method: "orderDesc", Attribute: "$updatedAt"},
		{Method: "limit", Values: []any{chatListLimit}},
	}
	var last error
	apis := c.tableAPIs(c.ConversationsTable)
	for i, api := range apis {
		items, err := c.listConversationsAt(ctx, api, session, queries, userID)
		if err == nil {
			return items, nil
		}
		last = err
		if IsMissingTable(err) || !isRouteMissing(err) || i == len(apis)-1 {
			return nil, err
		}
	}
	return nil, last
}

// ListChatMessages lit un fil, dans l'ordre des tours.
func (c *Client) ListChatMessages(ctx context.Context, session, userID, conversationID string) ([]ChatMessage, error) {
	if !c.HasChats() || !ValidID(userID) || !ValidID(conversationID) {
		return nil, &APIError{Status: http.StatusBadRequest, Type: "general_argument_invalid"}
	}
	if _, err := c.ownedConversation(ctx, session, userID, conversationID); err != nil {
		return nil, err
	}
	queries := []appwriteQuery{
		{Method: "equal", Attribute: "conversationId", Values: []any{conversationID}},
		{Method: "orderAsc", Attribute: "seq"},
		{Method: "limit", Values: []any{chatMessageLimit}},
	}
	var last error
	apis := c.tableAPIs(c.MessagesTable)
	for i, api := range apis {
		items, err := c.listMessagesAt(ctx, api, session, queries, userID, conversationID)
		if err == nil {
			return items, nil
		}
		last = err
		if IsMissingTable(err) || !isRouteMissing(err) || i == len(apis)-1 {
			return nil, err
		}
	}
	return nil, last
}

// AppendChatTurn ajoute la question et la réponse au fil du compte.
// Un identifiant inconnu ou d'un autre compte ouvre un nouveau fil.
func (c *Client) AppendChatTurn(ctx context.Context, session, userID, conversationID, question, answer, contextPath string, sources []ChatSource) (ChatConversation, error) {
	if !c.HasChats() || !ValidID(userID) {
		return ChatConversation{}, &APIError{Status: http.StatusServiceUnavailable, Type: "not_configured"}
	}
	question = clipRunes(strings.TrimSpace(question), chatBodyRunes)
	answer = clipRunes(strings.TrimSpace(answer), chatBodyRunes)
	contextPath = clipRunes(strings.TrimSpace(contextPath), chatPathRunes)
	if question == "" {
		return ChatConversation{}, &APIError{Status: http.StatusBadRequest, Type: "general_argument_invalid"}
	}
	var last error
	apis := c.tableAPIs(c.ConversationsTable)
	messageAPIs := c.tableAPIs(c.MessagesTable)
	for i, api := range apis {
		messageAPI := messageAPIs[0]
		if i < len(messageAPIs) {
			messageAPI = messageAPIs[i]
		}
		convo, err := c.appendChatWith(ctx, api, messageAPI, session, userID, conversationID, question, answer, contextPath, sources)
		if err == nil {
			return convo, nil
		}
		last = err
		if IsMissingTable(err) || !isRouteMissing(err) || i == len(apis)-1 {
			return ChatConversation{}, err
		}
	}
	return ChatConversation{}, last
}

func (c *Client) appendChatWith(ctx context.Context, convoAPI, messageAPI dataAPI, session, userID, conversationID, question, answer, contextPath string, sources []ChatSource) (ChatConversation, error) {
	convo, err := c.ownedConversationOn(ctx, convoAPI, session, userID, conversationID)
	created := false
	if err != nil || convo.ID == "" {
		convo, err = c.createConversation(ctx, convoAPI, session, userID, question, contextPath)
		if err != nil {
			return ChatConversation{}, err
		}
		created = true
	}
	seq, err := c.nextMessageSeq(ctx, messageAPI, session, convo.ID)
	if err != nil {
		return ChatConversation{}, err
	}
	if _, err := c.createMessage(ctx, messageAPI, session, userID, convo.ID, "user", question, seq, nil); err != nil {
		return ChatConversation{}, err
	}
	if _, err := c.createMessage(ctx, messageAPI, session, userID, convo.ID, "assistant", answer, seq+1, sources); err != nil {
		return ChatConversation{}, err
	}
	preview := clipRunes(question, chatPreviewRunes)
	if _, err := c.do(ctx, http.MethodPatch, fmtRow(convoAPI.update, convo.ID), session, map[string]any{
		"data": map[string]any{"preview": preview, "contextPath": contextPath},
	}); err != nil && created {
		return convo, nil
	}
	convo.Preview = preview
	convo.ContextPath = contextPath
	return convo, nil
}

func (c *Client) createConversation(ctx context.Context, api dataAPI, session, userID, question, contextPath string) (ChatConversation, error) {
	rowID, err := newRowID()
	if err != nil {
		return ChatConversation{}, err
	}
	title := clipRunes(question, chatTitleRunes)
	data := map[string]any{
		"userId":      userID,
		"title":       title,
		"preview":     title,
		"contextPath": contextPath,
	}
	if _, err := c.do(ctx, http.MethodPost, api.create, session, map[string]any{
		api.idKey:     rowID,
		"data":        data,
		"permissions": ownerPermissions(userID),
	}); err != nil {
		return ChatConversation{}, err
	}
	return ChatConversation{ID: rowID, Title: title, Preview: title, ContextPath: contextPath}, nil
}

func (c *Client) createMessage(ctx context.Context, api dataAPI, session, userID, conversationID, role, body string, seq int, sources []ChatSource) (string, error) {
	rowID, err := newRowID()
	if err != nil {
		return "", err
	}
	if role != "assistant" {
		role = "user"
	}
	data := map[string]any{
		"userId":         userID,
		"conversationId": conversationID,
		"role":           role,
		"seq":            seq,
		"body":           body,
		"sources":        encodeSources(sources),
	}
	if _, err := c.do(ctx, http.MethodPost, api.create, session, map[string]any{
		api.idKey:     rowID,
		"data":        data,
		"permissions": ownerPermissions(userID),
	}); err != nil {
		return "", err
	}
	return rowID, nil
}

func (c *Client) ownedConversation(ctx context.Context, session, userID, conversationID string) (ChatConversation, error) {
	if !ValidID(conversationID) {
		return ChatConversation{}, &APIError{Status: http.StatusNotFound, Type: "row_not_found"}
	}
	var last error
	for i, api := range c.tableAPIs(c.ConversationsTable) {
		item, err := c.ownedConversationOn(ctx, api, session, userID, conversationID)
		if err == nil {
			return item, nil
		}
		last = err
		if IsMissingTable(err) || !isRouteMissing(err) || i == len(c.tableAPIs(c.ConversationsTable))-1 {
			return ChatConversation{}, err
		}
	}
	return ChatConversation{}, last
}

func (c *Client) ownedConversationOn(ctx context.Context, api dataAPI, session, userID, conversationID string) (ChatConversation, error) {
	if !ValidID(conversationID) {
		return ChatConversation{}, &APIError{Status: http.StatusNotFound, Type: "row_not_found"}
	}
	result, err := c.do(ctx, http.MethodGet, fmtRow(api.get, conversationID), session, nil)
	if err != nil {
		return ChatConversation{}, err
	}
	item := conversationFrom(result.Body)
	if item.ID == "" {
		item.ID = conversationID
	}
	owner := ownerFrom(result.Body)
	if owner != "" && owner != userID {
		return ChatConversation{}, &APIError{Status: http.StatusForbidden, Type: "user_unauthorized"}
	}
	return item, nil
}

func (c *Client) nextMessageSeq(ctx context.Context, api dataAPI, session, conversationID string) (int, error) {
	queries := []appwriteQuery{
		{Method: "equal", Attribute: "conversationId", Values: []any{conversationID}},
		{Method: "orderDesc", Attribute: "seq"},
		{Method: "limit", Values: []any{1}},
	}
	items, err := c.listMessagesAt(ctx, api, session, queries, "", conversationID)
	if err != nil {
		if isSkippableFavoriteQuery(err) {
			return 1, nil
		}
		return 0, err
	}
	max := 0
	for _, item := range items {
		if item.Seq > max {
			max = item.Seq
		}
	}
	return max + 1, nil
}

func (c *Client) listConversationsAt(ctx context.Context, api dataAPI, session string, queries []appwriteQuery, userID string) ([]ChatConversation, error) {
	result, err := c.do(ctx, http.MethodGet, queryPath(api.create, queries), session, nil)
	if err != nil {
		return nil, err
	}
	rows := rowList(result.Body)
	items := make([]ChatConversation, 0, len(rows))
	for _, row := range rows {
		owner := firstString(row, mapData(row), "userId")
		if userID != "" && owner != "" && owner != userID {
			continue
		}
		item := conversationFromMap(row)
		if item.ID == "" {
			continue
		}
		items = append(items, item)
	}
	return items, nil
}

func (c *Client) listMessagesAt(ctx context.Context, api dataAPI, session string, queries []appwriteQuery, userID, conversationID string) ([]ChatMessage, error) {
	result, err := c.do(ctx, http.MethodGet, queryPath(api.create, queries), session, nil)
	if err != nil {
		return nil, err
	}
	rows := rowList(result.Body)
	items := make([]ChatMessage, 0, len(rows))
	for _, row := range rows {
		owner := firstString(row, mapData(row), "userId")
		if userID != "" && owner != "" && owner != userID {
			continue
		}
		item := messageFromMap(row)
		if item.Text == "" && item.Role == "" {
			continue
		}
		if conversationID != "" && item.ConversationID != "" && item.ConversationID != conversationID {
			continue
		}
		items = append(items, item)
	}
	return items, nil
}

func (c *Client) tableAPIs(tableID string) []dataAPI {
	db := url.PathEscape(c.DatabaseID)
	table := url.PathEscape(firstNonEmpty(tableID, "conversations"))
	tables := dataAPI{
		get:    "/tablesdb/" + db + "/tables/" + table + "/rows/%s",
		create: "/tablesdb/" + db + "/tables/" + table + "/rows",
		update: "/tablesdb/" + db + "/tables/" + table + "/rows/%s",
		idKey:  "rowId",
	}
	documents := dataAPI{
		get:    "/databases/" + db + "/collections/" + table + "/documents/%s",
		create: "/databases/" + db + "/collections/" + table + "/documents",
		update: "/databases/" + db + "/collections/" + table + "/documents/%s",
		idKey:  "documentId",
	}
	if c.Flavor == "databases" {
		return []dataAPI{documents, tables}
	}
	return []dataAPI{tables, documents}
}

func queryPath(createPath string, queries []appwriteQuery) string {
	values := url.Values{}
	for _, query := range queries {
		raw, err := json.Marshal(query)
		if err != nil {
			continue
		}
		values.Add("queries[]", string(raw))
	}
	if len(values) == 0 {
		return createPath
	}
	return createPath + "?" + values.Encode()
}

func fmtRow(pattern, id string) string {
	return strings.Replace(pattern, "%s", url.PathEscape(id), 1)
}

func rowList(raw []byte) []map[string]any {
	var payload map[string]any
	if json.Unmarshal(raw, &payload) != nil {
		return nil
	}
	rows, _ := payload["rows"].([]any)
	if rows == nil {
		rows, _ = payload["documents"].([]any)
	}
	out := make([]map[string]any, 0, len(rows))
	for _, rawRow := range rows {
		row, _ := rawRow.(map[string]any)
		if row != nil {
			out = append(out, row)
		}
	}
	return out
}

func conversationFrom(raw []byte) ChatConversation {
	var payload map[string]any
	if json.Unmarshal(raw, &payload) != nil {
		return ChatConversation{}
	}
	return conversationFromMap(payload)
}

func conversationFromMap(row map[string]any) ChatConversation {
	if row == nil {
		return ChatConversation{}
	}
	nested := mapData(row)
	return ChatConversation{
		ID:          firstString(row, nil, "$id"),
		Title:       firstString(row, nested, "title"),
		Preview:     firstString(row, nested, "preview"),
		ContextPath: firstString(row, nested, "contextPath"),
	}
}

func messageFromMap(row map[string]any) ChatMessage {
	if row == nil {
		return ChatMessage{}
	}
	nested := mapData(row)
	role := firstString(row, nested, "role")
	if role != "assistant" {
		role = "user"
	}
	return ChatMessage{
		ID:             firstString(row, nil, "$id"),
		ConversationID: firstString(row, nested, "conversationId"),
		Role:           role,
		Text:           firstString(row, nested, "body"),
		Seq:            firstInt(row, nested, "seq"),
		Sources:        decodeSources(firstString(row, nested, "sources")),
	}
}

func ownerFrom(raw []byte) string {
	var payload map[string]any
	if json.Unmarshal(raw, &payload) != nil {
		return ""
	}
	return firstString(payload, mapData(payload), "userId")
}

func encodeSources(sources []ChatSource) string {
	if len(sources) == 0 {
		return ""
	}
	compact := make([]ChatSource, 0, len(sources))
	for _, source := range sources {
		path := clipRunes(strings.TrimSpace(source.Path), 240)
		if path == "" {
			continue
		}
		compact = append(compact, ChatSource{
			Path: path,
			Name: clipRunes(strings.TrimSpace(source.Name), 120),
			Type: clipRunes(strings.TrimSpace(source.Type), 32),
		})
		if len(compact) == 6 {
			break
		}
	}
	raw, err := json.Marshal(compact)
	if err != nil {
		return ""
	}
	return clipRunes(string(raw), chatSourcesRunes)
}

func decodeSources(raw string) []ChatSource {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var sources []ChatSource
	if json.Unmarshal([]byte(raw), &sources) != nil {
		return nil
	}
	return sources
}

func firstInt(row, nested map[string]any, key string) int {
	for _, source := range []map[string]any{nested, row} {
		if source == nil {
			continue
		}
		switch value := source[key].(type) {
		case float64:
			return int(value)
		case int:
			return value
		case json.Number:
			n, _ := value.Int64()
			return int(n)
		}
	}
	return 0
}

func clipRunes(value string, limit int) string {
	if limit <= 0 || utf8.RuneCountInString(value) <= limit {
		return value
	}
	runes := []rune(value)
	return string(runes[:limit])
}
