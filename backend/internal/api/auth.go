package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"enise-docs/backend/internal/appwrite"
	"enise-docs/backend/internal/catalog"
)

const (
	sessionCookie  = "enise_session"
	sessionMaxAge  = 30 * 24 * 60 * 60
	authRateLimit  = 10
	minPasswordLen = 12
	maxPasswordLen = 256
	maxAuthBody    = 8 * 1024
)

var (
	promotions = []string{"3A", "4A", "5A", "Alumni", "Staff"}
	filieres   = []string{"GM", "GC", "GP", "Autre"}
)

type authLimiter struct {
	mu   sync.Mutex
	hits map[string][]time.Time
}

func newAuthLimiter() *authLimiter {
	return &authLimiter{hits: map[string][]time.Time{}}
}

func (l *authLimiter) allow(key string) bool {
	if l == nil {
		return true
	}
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	recent := make([]time.Time, 0, len(l.hits[key])+1)
	for _, hit := range l.hits[key] {
		if now.Sub(hit) < time.Minute {
			recent = append(recent, hit)
		}
	}
	if len(recent) >= authRateLimit {
		l.hits[key] = recent
		return false
	}
	l.hits[key] = append(recent, now)
	return true
}

type authBody struct {
	Email     string `json:"email"`
	Password  string `json:"password"`
	Confirm   string `json:"confirm"`
	Name      string `json:"name"`
	Promotion string `json:"promotion"`
	Filiere   string `json:"filiere"`
	Bio       string `json:"bio"`
	Current   string `json:"current"`
	Next      string `json:"next"`
	UserID    string `json:"userId"`
	Secret    string `json:"secret"`
}

func (s *Server) handleAuth(w http.ResponseWriter, r *http.Request) error {
	switch r.URL.Path {
	case "/api/auth/session":
		if r.Method != http.MethodGet {
			return methodNotAllowed(w, http.MethodGet)
		}
		return s.handleAuthSession(w, r)
	case "/api/auth/signup":
		return s.allow(w, r, http.MethodPost, s.handleAuthSignup)
	case "/api/auth/login":
		return s.allow(w, r, http.MethodPost, s.handleAuthLogin)
	case "/api/auth/logout":
		return s.allow(w, r, http.MethodPost, s.handleAuthLogout)
	case "/api/auth/verify":
		return s.allow(w, r, http.MethodPost, s.handleAuthVerify)
	case "/api/auth/recover":
		return s.allow(w, r, http.MethodPost, s.handleAuthRecover)
	case "/api/auth/password":
		return s.allow(w, r, http.MethodPost, s.handleAuthPassword)
	case "/api/auth/profile":
		return s.allow(w, r, http.MethodPost, s.handleAuthProfile)
	default:
		return catalog.Error(http.StatusNotFound, "Route API introuvable.")
	}
}

func (s *Server) handleAuthSession(w http.ResponseWriter, r *http.Request) error {
	if !s.authReady() {
		writeJSON(w, r, http.StatusOK, map[string]any{
			"configured":    false,
			"authenticated": false,
		}, "no-store", nil)
		return nil
	}
	secret := sessionFrom(r)
	if secret == "" {
		s.writeAuthState(w, r, nil, nil, "")
		return nil
	}
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	user, err := s.appwrite().GetAccount(ctx, secret)
	if err != nil {
		if authStatus(err) == http.StatusUnauthorized {
			clearSessionCookie(w, s.cookieSecure(r))
			s.writeAuthState(w, r, nil, nil, "")
			return nil
		}
		return s.authFail(err)
	}
	profile, warning := s.readProfile(ctx, secret, user)
	s.writeAuthState(w, r, &user, profile, warning)
	return nil
}

func (s *Server) handleAuthSignup(w http.ResponseWriter, r *http.Request) error {
	if err := s.authGate(w, r); err != nil {
		return err
	}
	body, err := readAuthBody(r)
	if err != nil {
		return err
	}
	email, emailErr := normalizeEmail(body.Email)
	if emailErr != "" {
		return catalog.Error(http.StatusBadRequest, emailErr)
	}
	if issue := validatePassword(body.Password, body.Confirm); issue != "" {
		return catalog.Error(http.StatusBadRequest, issue)
	}
	name := clipText(body.Name, 128)
	if name == "" {
		return catalog.Error(http.StatusBadRequest, "Indique un prénom ou un nom.")
	}
	promotion := defaultChoice(body.Promotion, promotions)
	filiere := defaultChoice(body.Filiere, filieres)
	if !contains(promotions, promotion) || !contains(filieres, filiere) {
		return catalog.Error(http.StatusBadRequest, "Promotion ou filière inconnue.")
	}
	ctx, cancel := context.WithTimeout(r.Context(), 40*time.Second)
	defer cancel()
	client := s.appwrite()
	userID, err := newUserID()
	if err != nil {
		return catalog.Error(http.StatusInternalServerError, "Création du compte impossible.")
	}
	user, err := client.CreateAccount(ctx, userID, email, body.Password, name)
	if err != nil {
		return s.authFail(err)
	}
	secret, err := client.CreateEmailSession(ctx, email, body.Password)
	if err != nil {
		writeJSON(w, r, http.StatusCreated, map[string]any{
			"ok":     true,
			"user":   publicUser(user),
			"notice": "Compte créé. Connecte-toi pour continuer.",
		}, "no-store", nil)
		return nil
	}
	setSessionCookie(w, secret, s.cookieSecure(r))
	profile, warning := s.saveProfile(ctx, client, secret, user, appwrite.Profile{
		DisplayName: name,
		Promotion:   promotion,
		Filiere:     filiere,
		Bio:         clipText(body.Bio, 280),
	})
	verification := "skipped"
	origin, ok := s.publicOrigin(r)
	if ok {
		if err := client.CreateVerification(ctx, secret, origin+"/?verify=1"); err != nil {
			verification = "failed"
		} else {
			verification = "sent"
		}
	}
	notice := "Compte créé. Un email de vérification a été envoyé."
	if verification != "sent" {
		notice = "Compte créé. L'email de vérification n'a pas pu partir."
	}
	if warning != "" {
		notice += " " + warning
	}
	writeJSON(w, r, http.StatusCreated, map[string]any{
		"ok":           true,
		"user":         publicUser(user),
		"profile":      publicProfile(profile),
		"verification": verification,
		"notice":       notice,
	}, "no-store", nil)
	return nil
}

func (s *Server) handleAuthLogin(w http.ResponseWriter, r *http.Request) error {
	if err := s.authGate(w, r); err != nil {
		return err
	}
	body, err := readAuthBody(r)
	if err != nil {
		return err
	}
	email, emailErr := normalizeEmail(body.Email)
	if emailErr != "" {
		return catalog.Error(http.StatusBadRequest, emailErr)
	}
	if body.Password == "" || len(body.Password) > maxPasswordLen {
		return catalog.Error(http.StatusBadRequest, "Email ou mot de passe incorrect.")
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	client := s.appwrite()
	secret, err := client.CreateEmailSession(ctx, email, body.Password)
	if err != nil {
		return s.authFail(err)
	}
	user, err := client.GetAccount(ctx, secret)
	if err != nil {
		return s.authFail(err)
	}
	setSessionCookie(w, secret, s.cookieSecure(r))
	profile, warning := s.readProfile(ctx, secret, user)
	s.writeAuthState(w, r, &user, profile, warning)
	return nil
}

func (s *Server) handleAuthLogout(w http.ResponseWriter, r *http.Request) error {
	if !s.authReady() {
		return catalog.Error(http.StatusServiceUnavailable, "Compte non configuré.")
	}
	if secret := sessionFrom(r); secret != "" {
		ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
		defer cancel()
		_ = s.appwrite().DeleteCurrentSession(ctx, secret)
	}
	clearSessionCookie(w, s.cookieSecure(r))
	writeJSON(w, r, http.StatusOK, map[string]any{"ok": true, "authenticated": false}, "no-store", nil)
	return nil
}

func (s *Server) handleAuthVerify(w http.ResponseWriter, r *http.Request) error {
	if err := s.authGate(w, r); err != nil {
		return err
	}
	body, err := readAuthBody(r)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	client := s.appwrite()
	secret := sessionFrom(r)
	if body.UserID == "" && body.Secret == "" {
		if secret == "" {
			return catalog.Error(http.StatusUnauthorized, "Connecte-toi pour renvoyer l'email.")
		}
		origin, ok := s.publicOrigin(r)
		if !ok {
			return catalog.Error(http.StatusBadRequest, "Impossible de construire le lien de retour.")
		}
		if err := client.CreateVerification(ctx, secret, origin+"/?verify=1"); err != nil {
			return s.authFail(err)
		}
		writeJSON(w, r, http.StatusOK, map[string]any{
			"ok":     true,
			"notice": "Email de vérification renvoyé.",
		}, "no-store", nil)
		return nil
	}
	if !appwrite.ValidID(body.UserID) || !appwrite.ValidToken(body.Secret) {
		return catalog.Error(http.StatusBadRequest, "Lien de vérification incomplet.")
	}
	if err := client.UpdateVerification(ctx, secret, body.UserID, body.Secret); err != nil {
		return s.authFail(err)
	}
	var user *appwrite.User
	if secret != "" {
		if fresh, err := client.GetAccount(ctx, secret); err == nil {
			user = &fresh
			input := appwrite.Profile{DisplayName: fresh.Name, Promotion: promotions[0], Filiere: filieres[0]}
			if current, readErr := client.ReadProfile(ctx, secret, fresh.ID); readErr == nil && current != nil {
				input = *current
			}
			_, _ = s.saveProfile(ctx, client, secret, fresh, input)
		}
	}
	writeJSON(w, r, http.StatusOK, map[string]any{
		"ok":     true,
		"user":   publicUserPtr(user),
		"notice": "Adresse email vérifiée.",
	}, "no-store", nil)
	return nil
}

func (s *Server) handleAuthRecover(w http.ResponseWriter, r *http.Request) error {
	if err := s.authGate(w, r); err != nil {
		return err
	}
	body, err := readAuthBody(r)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	client := s.appwrite()
	if body.UserID == "" && body.Secret == "" {
		email, emailErr := normalizeEmail(body.Email)
		if emailErr != "" {
			return catalog.Error(http.StatusBadRequest, emailErr)
		}
		origin, ok := s.publicOrigin(r)
		if !ok {
			return catalog.Error(http.StatusBadRequest, "Impossible de construire le lien de retour.")
		}
		if err := client.CreateRecovery(ctx, email, origin+"/?recover=1"); err != nil && !appwrite.HidesUnknownAccount(err) {
			return s.authFail(err)
		}
		writeJSON(w, r, http.StatusOK, map[string]any{
			"ok":     true,
			"notice": "Si un compte existe pour cette adresse, un email de réinitialisation a été envoyé.",
		}, "no-store", nil)
		return nil
	}
	if !appwrite.ValidID(body.UserID) || !appwrite.ValidToken(body.Secret) {
		return catalog.Error(http.StatusBadRequest, "Lien de réinitialisation incomplet.")
	}
	if issue := validatePassword(body.Password, body.Confirm); issue != "" {
		return catalog.Error(http.StatusBadRequest, issue)
	}
	if err := client.UpdateRecovery(ctx, body.UserID, body.Secret, body.Password); err != nil {
		return s.authFail(err)
	}
	clearSessionCookie(w, s.cookieSecure(r))
	writeJSON(w, r, http.StatusOK, map[string]any{
		"ok":     true,
		"notice": "Mot de passe mis à jour. Connecte-toi avec le nouveau.",
	}, "no-store", nil)
	return nil
}

func (s *Server) handleAuthPassword(w http.ResponseWriter, r *http.Request) error {
	if err := s.authGate(w, r); err != nil {
		return err
	}
	secret := sessionFrom(r)
	if secret == "" {
		return catalog.Error(http.StatusUnauthorized, "Connecte-toi pour changer le mot de passe.")
	}
	body, err := readAuthBody(r)
	if err != nil {
		return err
	}
	if issue := validatePassword(body.Next, body.Confirm); issue != "" {
		return catalog.Error(http.StatusBadRequest, issue)
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	if err := s.appwrite().UpdatePassword(ctx, secret, body.Next, body.Current); err != nil {
		return s.authFail(err)
	}
	writeJSON(w, r, http.StatusOK, map[string]any{
		"ok":     true,
		"notice": "Mot de passe mis à jour.",
	}, "no-store", nil)
	return nil
}

func (s *Server) handleAuthProfile(w http.ResponseWriter, r *http.Request) error {
	if err := s.authGate(w, r); err != nil {
		return err
	}
	secret := sessionFrom(r)
	if secret == "" {
		return catalog.Error(http.StatusUnauthorized, "Connecte-toi pour modifier ton profil.")
	}
	body, err := readAuthBody(r)
	if err != nil {
		return err
	}
	if body.Promotion != "" && !contains(promotions, body.Promotion) {
		return catalog.Error(http.StatusBadRequest, "Promotion inconnue.")
	}
	if body.Filiere != "" && !contains(filieres, body.Filiere) {
		return catalog.Error(http.StatusBadRequest, "Filière inconnue.")
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	client := s.appwrite()
	user, err := client.GetAccount(ctx, secret)
	if err != nil {
		return s.authFail(err)
	}
	name := clipText(body.Name, 128)
	if name != "" && name != user.Name {
		if err := client.UpdateName(ctx, secret, name); err != nil {
			return s.authFail(err)
		}
		user.Name = name
	}
	current, _ := client.ReadProfile(ctx, secret, user.ID)
	input := appwrite.Profile{DisplayName: user.Name}
	if current != nil {
		input = *current
	}
	if name != "" {
		input.DisplayName = name
	}
	if body.Promotion != "" {
		input.Promotion = body.Promotion
	}
	if body.Filiere != "" {
		input.Filiere = body.Filiere
	}
	input.Bio = clipText(body.Bio, 280)
	if input.Promotion == "" {
		input.Promotion = promotions[0]
	}
	if input.Filiere == "" {
		input.Filiere = filieres[0]
	}
	profile, warning := s.saveProfile(ctx, client, secret, user, input)
	notice := "Profil mis à jour."
	if warning != "" {
		notice = warning
	}
	writeJSON(w, r, http.StatusOK, map[string]any{
		"ok":      true,
		"user":    publicUser(user),
		"profile": publicProfile(profile),
		"notice":  notice,
	}, "no-store", nil)
	return nil
}

func (s *Server) authGate(w http.ResponseWriter, r *http.Request) error {
	if !s.authReady() {
		return catalog.Error(http.StatusServiceUnavailable, "Compte non configuré.")
	}
	if !s.authHits.allow(s.chatClientKey(r)) {
		w.Header().Set("Retry-After", "60")
		return catalog.Error(http.StatusTooManyRequests, "Trop de tentatives. Réessaie dans une minute.")
	}
	return nil
}

func (s *Server) authReady() bool {
	return s.cfg.AppwriteEnabled && appwrite.ValidEndpoint(s.cfg.AppwriteEndpoint) && appwrite.ValidProject(s.cfg.AppwriteProjectID)
}

func (s *Server) appwrite() *appwrite.Client {
	return &appwrite.Client{
		Endpoint:     s.cfg.AppwriteEndpoint,
		ProjectID:    s.cfg.AppwriteProjectID,
		DatabaseID:   s.cfg.AppwriteDatabaseID,
		ProfileTable: s.cfg.AppwriteProfileTable,
		Flavor:       s.cfg.AppwriteFlavor,
		HTTP:         s.authClient,
	}
}

func (s *Server) readProfile(ctx context.Context, session string, user appwrite.User) (*appwrite.Profile, string) {
	if !s.appwrite().HasDatabase() {
		return nil, ""
	}
	profile, err := s.appwrite().ReadProfile(ctx, session, user.ID)
	if err != nil {
		return nil, "Profil illisible pour le moment."
	}
	return profile, ""
}

func (s *Server) saveProfile(ctx context.Context, client *appwrite.Client, session string, user appwrite.User, input appwrite.Profile) (*appwrite.Profile, string) {
	if !client.HasDatabase() {
		return nil, "Le nom est enregistré sur le compte. La table profils n'est pas encore provisionnée."
	}
	profile, err := client.UpsertProfile(ctx, session, user, input)
	if err != nil {
		return nil, appwrite.French(err)
	}
	return profile, ""
}

func (s *Server) writeAuthState(w http.ResponseWriter, r *http.Request, user *appwrite.User, profile *appwrite.Profile, warning string) {
	payload := map[string]any{
		"configured":    s.authReady(),
		"authenticated": user != nil,
		"user":          publicUserPtr(user),
		"profile":       publicProfile(profile),
		"profileTable":  s.appwrite().HasDatabase(),
	}
	if warning != "" {
		payload["profileWarning"] = warning
	}
	writeJSON(w, r, http.StatusOK, payload, "no-store", nil)
}

func (s *Server) authFail(err error) error {
	var apiErr *appwrite.APIError
	if errors.As(err, &apiErr) && apiErr != nil {
		status := apiErr.Status
		switch status {
		case http.StatusBadRequest, http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound, http.StatusConflict, http.StatusTooManyRequests:
		default:
			status = http.StatusBadGateway
		}
		return catalog.Error(status, appwrite.French(err))
	}
	return catalog.Error(http.StatusBadGateway, "Le service de compte est injoignable.")
}

func (s *Server) cookieSecure(r *http.Request) bool {
	origin, ok := s.publicOrigin(r)
	return ok && strings.HasPrefix(origin, "https://")
}

func (s *Server) publicOrigin(r *http.Request) (string, bool) {
	if origin := cleanOrigin(s.cfg.AppwritePublicOrigin); origin != "" {
		return origin, true
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	host := r.Host
	if s.trustForwarded(r) {
		if proto := firstToken(r.Header.Get("X-Forwarded-Proto")); proto == "https" || proto == "http" {
			scheme = proto
		}
		if forwarded := firstToken(r.Header.Get("X-Forwarded-Host")); validPublicHost(forwarded) {
			host = forwarded
		}
	}
	if !validPublicHost(host) {
		return "", false
	}
	return scheme + "://" + host, true
}

func (s *Server) trustForwarded(r *http.Request) bool {
	if s.cfg.ChatTrustProxy {
		return true
	}
	return remoteIsPrivate(remoteHost(r.RemoteAddr))
}

func sessionFrom(r *http.Request) string {
	cookie, err := r.Cookie(sessionCookie)
	if err != nil || cookie == nil || !appwrite.ValidToken(cookie.Value) {
		return ""
	}
	return cookie.Value
}

func setSessionCookie(w http.ResponseWriter, secret string, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    secret,
		Path:     "/",
		MaxAge:   sessionMaxAge,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	})
}

func clearSessionCookie(w http.ResponseWriter, secure bool) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	})
}

func readAuthBody(r *http.Request) (authBody, error) {
	var body authBody
	decoder := json.NewDecoder(http.MaxBytesReader(nil, r.Body, maxAuthBody))
	if err := decoder.Decode(&body); err != nil {
		return authBody{}, catalog.Error(http.StatusBadRequest, "Requête illisible.")
	}
	return body, nil
}

func publicUser(user appwrite.User) map[string]any {
	return map[string]any{
		"id":                user.ID,
		"email":             user.Email,
		"name":              user.Name,
		"emailVerification": user.EmailVerification,
	}
}

func publicUserPtr(user *appwrite.User) any {
	if user == nil {
		return nil
	}
	return publicUser(*user)
}

func publicProfile(profile *appwrite.Profile) any {
	if profile == nil {
		return nil
	}
	return map[string]any{
		"displayName":   profile.DisplayName,
		"promotion":     profile.Promotion,
		"filiere":       profile.Filiere,
		"bio":           profile.Bio,
		"emailVerified": profile.EmailVerified,
	}
}

func normalizeEmail(value string) (string, string) {
	email := strings.ToLower(strings.TrimSpace(value))
	if email == "" {
		return "", "Indique une adresse email."
	}
	if len(email) > 320 || strings.ContainsAny(email, " \t\r\n") {
		return "", "Adresse email incomplète."
	}
	at := strings.LastIndex(email, "@")
	if at < 1 || at > len(email)-4 || strings.Contains(email[:at], "@") {
		return "", "Adresse email incomplète."
	}
	domain := email[at+1:]
	if !strings.Contains(domain, ".") || strings.HasPrefix(domain, ".") || strings.HasSuffix(domain, ".") {
		return "", "Adresse email incomplète."
	}
	return email, ""
}

func validatePassword(password, confirm string) string {
	if len(password) < minPasswordLen {
		return "Mot de passe trop court : 12 caractères minimum."
	}
	if len(password) > maxPasswordLen {
		return "Mot de passe trop long : 256 caractères maximum."
	}
	if confirm != "" && password != confirm {
		return "Les deux mots de passe diffèrent."
	}
	if confirm == "" {
		return "Confirme le mot de passe."
	}
	return ""
}

func defaultChoice(value string, choices []string) string {
	value = strings.TrimSpace(value)
	if value == "" && len(choices) > 0 {
		return choices[0]
	}
	return value
}

func contains(choices []string, value string) bool {
	for _, choice := range choices {
		if choice == value {
			return true
		}
	}
	return false
}

func clipText(value string, max int) string {
	value = strings.TrimSpace(value)
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return string(runes[:max])
}

func newUserID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf)[:20], nil
}

func authStatus(err error) int {
	var apiErr *appwrite.APIError
	if errors.As(err, &apiErr) && apiErr != nil {
		return apiErr.Status
	}
	return 0
}

func methodNotAllowed(w http.ResponseWriter, method string) error {
	w.Header().Set("Allow", method)
	return catalog.Error(http.StatusMethodNotAllowed, "Méthode non autorisée.")
}

func cleanOrigin(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if strings.ContainsAny(raw, " \t\r\n") {
		return ""
	}
	parsed, err := http.NewRequest(http.MethodGet, raw, nil)
	if err != nil || parsed.URL.Host == "" || parsed.URL.User != nil {
		return ""
	}
	if parsed.URL.Scheme != "https" && parsed.URL.Scheme != "http" {
		return ""
	}
	if parsed.URL.Path != "" && parsed.URL.Path != "/" {
		return ""
	}
	if parsed.URL.RawQuery != "" || parsed.URL.Fragment != "" {
		return ""
	}
	return parsed.URL.Scheme + "://" + parsed.URL.Host
}

func validPublicHost(host string) bool {
	host = strings.TrimSpace(host)
	if host == "" || len(host) > 255 || strings.ContainsAny(host, " \t\r\n/\\@?#") {
		return false
	}
	return true
}

func firstToken(value string) string {
	value = strings.TrimSpace(value)
	if i := strings.IndexByte(value, ','); i >= 0 {
		value = strings.TrimSpace(value[:i])
	}
	return value
}
