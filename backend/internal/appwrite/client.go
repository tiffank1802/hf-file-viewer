// Package appwrite parle au projet Appwrite depuis le processus Go.
// Le navigateur ne reçoit jamais la clé API, ni le secret de session :
// ce secret reste dans un cookie HttpOnly posé par nos routes /api/auth.
package appwrite

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	maxResponseBytes = 64 * 1024
	userAgent        = "enise-docs-go"
)

// User est le compte Auth, sans hash ni secret.
type User struct {
	ID                string
	Email             string
	Name              string
	EmailVerification bool
}

// Profile est la ligne de la table profiles, si la base est provisionnée.
type Profile struct {
	DisplayName   string `json:"displayName"`
	Promotion     string `json:"promotion"`
	Filiere       string `json:"filiere"`
	Bio           string `json:"bio"`
	EmailVerified bool   `json:"emailVerified"`
}

// APIError est une réponse Appwrite. Detail n'est pas renvoyé au navigateur.
type APIError struct {
	Status int
	Type   string
	Detail string
}

func (e *APIError) Error() string {
	if e == nil {
		return ""
	}
	if e.Type != "" {
		return fmt.Sprintf("appwrite %d %s", e.Status, e.Type)
	}
	return fmt.Sprintf("appwrite %d", e.Status)
}

// Client appelle l'API REST Appwrite avec la session de l'étudiant, pas une clé admin.
type Client struct {
	Endpoint           string
	ProjectID          string
	DatabaseID         string
	ProfileTable       string
	FavoritesTable     string
	ConversationsTable string
	MessagesTable      string
	Flavor             string
	HTTP               *http.Client
}

func (c *Client) httpClient() *http.Client {
	if c != nil && c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{
		Timeout: 12 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func (c *Client) ready() bool {
	return c != nil && ValidEndpoint(c.Endpoint) && ValidProject(c.ProjectID)
}

// HasDatabase dit si une table de profil peut être lue ou écrite.
func (c *Client) HasDatabase() bool {
	return c.ready() && ValidID(c.DatabaseID) && ValidID(firstNonEmpty(c.ProfileTable, "profiles"))
}

type callResult struct {
	Status  int
	Body    []byte
	Cookies []*http.Cookie
}

func (c *Client) do(ctx context.Context, method, path, session string, body any) (*callResult, error) {
	if !c.ready() {
		return nil, &APIError{Status: http.StatusServiceUnavailable, Type: "not_configured"}
	}
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(payload)
	}
	endpoint := strings.TrimRight(c.Endpoint, "/")
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("X-Appwrite-Project", c.ProjectID)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if session != "" {
		req.Header.Set("X-Appwrite-Session", session)
		req.AddCookie(&http.Cookie{Name: "a_session_" + c.ProjectID, Value: session})
	}
	resp, err := c.httpClient().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes))
	if err != nil {
		return nil, err
	}
	result := &callResult{Status: resp.StatusCode, Body: raw, Cookies: resp.Cookies()}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return result, parseAPIError(resp.StatusCode, raw)
	}
	return result, nil
}

func parseAPIError(status int, raw []byte) *APIError {
	apiErr := &APIError{Status: status}
	var payload map[string]any
	if json.Unmarshal(raw, &payload) == nil {
		apiErr.Type = stringField(payload, "type")
		apiErr.Detail = stringField(payload, "message")
	}
	return apiErr
}

// CreateAccount crée le compte Auth. Le mot de passe n'est pas relu ensuite.
func (c *Client) CreateAccount(ctx context.Context, userID, email, password, name string) (User, error) {
	result, err := c.do(ctx, http.MethodPost, "/account", "", map[string]string{
		"userId":   userID,
		"email":    email,
		"password": password,
		"name":     name,
	})
	if err != nil {
		return User{}, err
	}
	return userFrom(result.Body)
}

// CreateEmailSession ouvre une session et renvoie seulement son secret.
func (c *Client) CreateEmailSession(ctx context.Context, email, password string) (string, error) {
	result, err := c.do(ctx, http.MethodPost, "/account/sessions/email", "", map[string]string{
		"email":    email,
		"password": password,
	})
	if err != nil {
		return "", err
	}
	secret := SessionSecret(c.ProjectID, result.Cookies, result.Body)
	if !ValidToken(secret) {
		return "", &APIError{Status: http.StatusBadGateway, Type: "missing_session"}
	}
	return secret, nil
}

func (c *Client) GetAccount(ctx context.Context, session string) (User, error) {
	result, err := c.do(ctx, http.MethodGet, "/account", session, nil)
	if err != nil {
		return User{}, err
	}
	return userFrom(result.Body)
}

func (c *Client) DeleteCurrentSession(ctx context.Context, session string) error {
	_, err := c.do(ctx, http.MethodDelete, "/account/sessions/current", session, nil)
	return err
}

func (c *Client) CreateVerification(ctx context.Context, session, redirect string) error {
	_, err := c.do(ctx, http.MethodPost, "/account/verification", session, map[string]string{"url": redirect})
	return err
}

func (c *Client) UpdateVerification(ctx context.Context, session, userID, secret string) error {
	_, err := c.do(ctx, http.MethodPut, "/account/verification", session, map[string]string{
		"userId": userID,
		"secret": secret,
	})
	return err
}

func (c *Client) CreateRecovery(ctx context.Context, email, redirect string) error {
	_, err := c.do(ctx, http.MethodPost, "/account/recovery", "", map[string]string{
		"email": email,
		"url":   redirect,
	})
	return err
}

func (c *Client) UpdateRecovery(ctx context.Context, userID, secret, password string) error {
	_, err := c.do(ctx, http.MethodPut, "/account/recovery", "", map[string]string{
		"userId":   userID,
		"secret":   secret,
		"password": password,
	})
	return err
}

func (c *Client) UpdatePassword(ctx context.Context, session, password, oldPassword string) error {
	body := map[string]string{"password": password}
	if oldPassword != "" {
		body["oldPassword"] = oldPassword
	}
	_, err := c.do(ctx, http.MethodPut, "/account/password", session, body)
	return err
}

func (c *Client) UpdateName(ctx context.Context, session, name string) error {
	_, err := c.do(ctx, http.MethodPut, "/account/name", session, map[string]string{"name": name})
	return err
}

// ReadProfile lit la ligne dont l'identifiant est celui du compte.
// Une table absente ou non provisionnée n'est pas une erreur de session.
func (c *Client) ReadProfile(ctx context.Context, session, userID string) (*Profile, error) {
	if !c.HasDatabase() || !ValidID(userID) {
		return nil, nil
	}
	var last error
	apis := c.dataAPIs()
	for i, api := range apis {
		result, err := c.do(ctx, http.MethodGet, fmt.Sprintf(api.get, url.PathEscape(userID)), session, nil)
		if err == nil {
			profile := profileFrom(result.Body)
			return &profile, nil
		}
		last = err
		if isMissingRow(err) {
			return nil, nil
		}
		if !isRouteMissing(err) || i == len(apis)-1 {
			return nil, err
		}
	}
	return nil, last
}

// UpsertProfile crée ou met à jour la ligne de l'étudiant.
func (c *Client) UpsertProfile(ctx context.Context, session string, user User, input Profile) (*Profile, error) {
	if !c.HasDatabase() || !ValidID(user.ID) {
		return nil, nil
	}
	data := map[string]any{
		"userId":        user.ID,
		"displayName":   clip(input.DisplayName, 128),
		"bio":           clip(input.Bio, 280),
		"promotion":     input.Promotion,
		"filiere":       input.Filiere,
		"emailVerified": user.EmailVerification,
		"lastSeenAt":    time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
	}
	permissions := []string{
		`read("user:` + user.ID + `")`,
		`update("user:` + user.ID + `")`,
		`delete("user:` + user.ID + `")`,
	}
	var last error
	apis := c.dataAPIs()
	for i, api := range apis {
		profile, err := c.upsertWith(ctx, api, session, user.ID, data, permissions)
		if err == nil {
			return profile, nil
		}
		last = err
		if !isRouteMissing(err) || i == len(apis)-1 {
			return nil, err
		}
	}
	return nil, last
}

type dataAPI struct {
	get    string
	create string
	update string
	idKey  string
}

func (c *Client) dataAPIs() []dataAPI {
	db := url.PathEscape(c.DatabaseID)
	table := url.PathEscape(firstNonEmpty(c.ProfileTable, "profiles"))
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

func (c *Client) upsertWith(ctx context.Context, api dataAPI, session, userID string, data map[string]any, permissions []string) (*Profile, error) {
	_, err := c.do(ctx, http.MethodGet, fmt.Sprintf(api.get, url.PathEscape(userID)), session, nil)
	if isRouteMissing(err) {
		return nil, err
	}
	if err != nil && !isMissingRow(err) {
		return nil, err
	}
	if isMissingRow(err) {
		created, createErr := c.do(ctx, http.MethodPost, api.create, session, map[string]any{
			api.idKey:     userID,
			"data":        data,
			"permissions": permissions,
		})
		if createErr == nil {
			profile := profileFrom(created.Body)
			return &profile, nil
		}
		if !isConflict(createErr) {
			return nil, createErr
		}
	}
	updated, err := c.do(ctx, http.MethodPatch, fmt.Sprintf(api.update, url.PathEscape(userID)), session, map[string]any{
		"data": data,
	})
	if err != nil {
		return nil, err
	}
	profile := profileFrom(updated.Body)
	return &profile, nil
}

// SessionSecret lit le secret posé par Appwrite, d'abord dans le cookie.
func SessionSecret(projectID string, cookies []*http.Cookie, body []byte) string {
	exact := "a_session_" + projectID
	fallback := ""
	for _, cookie := range cookies {
		if cookie == nil || cookie.Value == "" || strings.Contains(cookie.Name, "legacy") {
			continue
		}
		if cookie.Name == exact {
			return cookie.Value
		}
		if strings.HasPrefix(cookie.Name, "a_session_") && fallback == "" {
			fallback = cookie.Value
		}
	}
	if fallback != "" {
		return fallback
	}
	var payload map[string]any
	if json.Unmarshal(body, &payload) == nil {
		if secret := stringField(payload, "secret"); secret != "" {
			return secret
		}
	}
	return ""
}

// French traduit un refus Appwrite sans recopier le message amont.
func French(err error) string {
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr == nil {
		return "Le service de compte est indisponible."
	}
	if message, ok := frenchByType[apiErr.Type]; ok {
		return message
	}
	switch apiErr.Status {
	case http.StatusUnauthorized:
		return "Email ou mot de passe incorrect."
	case http.StatusForbidden:
		return "Accès refusé pour ce compte."
	case http.StatusConflict:
		return "Un compte existe déjà avec cet email."
	case http.StatusTooManyRequests:
		return "Trop de tentatives. Réessaie dans une minute."
	}
	if safeType(apiErr.Type) {
		return "Le service de compte a refusé l'opération (" + apiErr.Type + ")."
	}
	return "Le service de compte est indisponible."
}

// HidesUnknownAccount dit si une récupération doit répondre comme si l'email existait.
func HidesUnknownAccount(err error) bool {
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr == nil {
		return false
	}
	return apiErr.Status == http.StatusNotFound || apiErr.Type == "user_not_found"
}

func isMissingRow(err error) bool {
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr == nil || apiErr.Status != http.StatusNotFound {
		return false
	}
	switch apiErr.Type {
	case "row_not_found", "document_not_found", "row_missing", "document_missing":
		return true
	default:
		return false
	}
}

func isRouteMissing(err error) bool {
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr == nil || apiErr.Status != http.StatusNotFound {
		return false
	}
	switch apiErr.Type {
	case "general_route_not_found", "general_not_found", "":
		return true
	default:
		return false
	}
}

func isConflict(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr != nil && apiErr.Status == http.StatusConflict
}

var frenchByType = map[string]string{
	"user_invalid_credentials":    "Email ou mot de passe incorrect.",
	"user_invalid_token":          "Lien expiré ou déjà utilisé.",
	"user_session_not_found":      "Session expirée. Reconnecte-toi.",
	"user_unauthorized":           "Connecte-toi pour continuer.",
	"user_blocked":                "Ce compte est bloqué.",
	"user_already_exists":         "Un compte existe déjà avec cet email.",
	"user_email_already_exists":   "Un compte existe déjà avec cet email.",
	"user_password_mismatch":      "Le mot de passe actuel est incorrect.",
	"user_email_already_verified": "Cette adresse est déjà vérifiée.",
	"general_rate_limit_exceeded": "Trop de tentatives. Réessaie dans une minute.",
	"general_argument_invalid":    "Information refusée.",
	"document_invalid_structure":  "Profil refusé par la table.",
	"row_invalid_structure":       "Profil refusé par la table.",
	"missing_session":             "Session non ouverte.",
	"not_configured":              "Compte non configuré.",
	"table_not_found":             "Table absente. Lance npm run appwrite:setup.",
	"collection_not_found":        "Table absente. Lance npm run appwrite:setup.",
}

func userFrom(raw []byte) (User, error) {
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return User{}, err
	}
	user := User{
		ID:                stringField(payload, "$id"),
		Email:             stringField(payload, "email"),
		Name:              stringField(payload, "name"),
		EmailVerification: boolField(payload, "emailVerification") || boolField(payload, "verification"),
	}
	if !ValidID(user.ID) {
		return User{}, &APIError{Status: http.StatusBadGateway, Type: "invalid_user"}
	}
	return user, nil
}

func profileFrom(raw []byte) Profile {
	var payload map[string]any
	if json.Unmarshal(raw, &payload) != nil {
		return Profile{}
	}
	data, _ := payload["data"].(map[string]any)
	return Profile{
		DisplayName:   firstString(payload, data, "displayName"),
		Promotion:     firstString(payload, data, "promotion"),
		Filiere:       firstString(payload, data, "filiere"),
		Bio:           firstString(payload, data, "bio"),
		EmailVerified: firstBool(payload, data, "emailVerified"),
	}
}

func firstString(top, nested map[string]any, key string) string {
	if value := stringField(top, key); value != "" {
		return value
	}
	return stringField(nested, key)
}

func firstBool(top, nested map[string]any, key string) bool {
	if _, ok := top[key]; ok {
		return boolField(top, key)
	}
	return boolField(nested, key)
}

func stringField(payload map[string]any, key string) string {
	if payload == nil {
		return ""
	}
	value, ok := payload[key].(string)
	if !ok {
		return ""
	}
	return value
}

func boolField(payload map[string]any, key string) bool {
	if payload == nil {
		return false
	}
	value, ok := payload[key].(bool)
	return ok && value
}

func clip(value string, max int) string {
	value = strings.TrimSpace(value)
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return string(runes[:max])
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func safeType(value string) bool {
	if value == "" || len(value) > 64 {
		return false
	}
	for _, r := range value {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '_' {
			return false
		}
	}
	return true
}

// ValidEndpoint n'accepte le HTTP que vers la boucle locale (tests).
func ValidEndpoint(raw string) bool {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" || parsed.User != nil {
		return false
	}
	if parsed.Scheme == "https" {
		return true
	}
	if parsed.Scheme != "http" {
		return false
	}
	ip := net.ParseIP(parsed.Hostname())
	return ip != nil && ip.IsLoopback()
}

// ValidProject contrôle l'identifiant public du projet Appwrite.
func ValidProject(value string) bool {
	return ValidID(value)
}

// ValidID reprend le format des identifiants Appwrite.
func ValidID(value string) bool {
	if len(value) < 1 || len(value) > 36 {
		return false
	}
	for i, r := range value {
		ok := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '.' || r == '-'
		if !ok || (i == 0 && (r == '_' || r == '.' || r == '-')) {
			return false
		}
	}
	return true
}

// ValidToken refuse tout secret qui pourrait casser un en-tête.
func ValidToken(value string) bool {
	if len(value) < 6 || len(value) > 512 {
		return false
	}
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '_' || r == '-' || r == '.' || r == '=' || r == '+':
		default:
			return false
		}
	}
	return true
}
