package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"enise-docs/backend/internal/config"
)

func TestLoginSetsHttpOnlyCookieAndHidesSecret(t *testing.T) {
	var calls int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("X-Appwrite-Project") != "69cedb12002acdd498e0" {
			t.Errorf("projet = %q", r.Header.Get("X-Appwrite-Project"))
		}
		if r.Header.Get("X-Appwrite-Key") != "" {
			t.Error("clé API transmise")
		}
		switch r.URL.Path {
		case "/account/sessions/email":
			http.SetCookie(w, &http.Cookie{Name: "a_session_69cedb12002acdd498e0", Value: "sessionsecret123"})
			_, _ = w.Write([]byte(`{"$id":"sess","secret":"sessionsecret123"}`))
		case "/account":
			if r.Header.Get("X-Appwrite-Session") != "sessionsecret123" {
				t.Errorf("session amont = %q", r.Header.Get("X-Appwrite-Session"))
			}
			_, _ = w.Write([]byte(`{"$id":"user123","email":"ada@enise.fr","name":"Ada","emailVerification":false}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()

	response := authRequest(t, upstream.URL, http.MethodPost, "/api/auth/login", `{"email":"ada@enise.fr","password":"motdepasse-secret"}`, "")
	if response.Code != http.StatusOK {
		t.Fatalf("statut %d : %s", response.Code, response.Body.String())
	}
	body := response.Body.String()
	if strings.Contains(body, "motdepasse-secret") || strings.Contains(body, "sessionsecret123") {
		t.Fatalf("secret dans la réponse : %s", body)
	}
	cookie := response.Result().Cookies()
	if len(cookie) != 1 || cookie[0].Name != "enise_session" || !cookie[0].HttpOnly || cookie[0].Value != "sessionsecret123" {
		t.Fatalf("cookie = %#v", cookie)
	}
	var payload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	user, _ := payload["user"].(map[string]any)
	if user["email"] != "ada@enise.fr" || payload["authenticated"] != true {
		t.Fatalf("payload = %#v", payload)
	}

	session := authRequest(t, upstream.URL, http.MethodGet, "/api/auth/session", "", "enise_session=sessionsecret123")
	if session.Code != http.StatusOK || !strings.Contains(session.Body.String(), "ada@enise.fr") {
		t.Fatalf("session %d %s", session.Code, session.Body.String())
	}
	if calls < 2 {
		t.Fatalf("appels = %d", calls)
	}
}

func TestSignupRejectsShortPasswordWithoutUpstream(t *testing.T) {
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusCreated)
	}))
	defer upstream.Close()
	response := authRequest(t, upstream.URL, http.MethodPost, "/api/auth/signup", `{"email":"ada@enise.fr","password":"abc","confirm":"abc","name":"Ada"}`, "")
	if response.Code != http.StatusBadRequest {
		t.Fatalf("statut %d", response.Code)
	}
	if calls != 0 {
		t.Fatalf("amont appelé %d fois", calls)
	}
	if strings.Contains(response.Body.String(), "abc") {
		t.Fatalf("mot de passe renvoyé : %s", response.Body.String())
	}
}

func TestInjectedSessionCookieIsIgnored(t *testing.T) {
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	request := httptest.NewRequest(http.MethodGet, "/api/auth/session", nil)
	request.RemoteAddr = "203.0.113.8:443"
	request.Host = "docs.enise.test"
	request.AddCookie(&http.Cookie{Name: "enise_session", Value: "abc\r\nX-Injected: 1"})
	response := httptest.NewRecorder()
	server := authServer(t, upstream.URL)
	if err := server.handleAuth(response, request); err != nil {
		t.Fatal(err)
	}
	if calls != 0 {
		t.Fatalf("cookie injecté transmis, appels = %d", calls)
	}
	if !strings.Contains(response.Body.String(), `"authenticated":false`) {
		t.Fatalf("corps = %s", response.Body.String())
	}
}

func TestRecoveryDoesNotRevealUnknownEmail(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"type":"user_not_found","message":"User with the requested ID could not be found."}`)
	}))
	defer upstream.Close()
	response := authRequest(t, upstream.URL, http.MethodPost, "/api/auth/recover", `{"email":"absent@enise.fr"}`, "")
	if response.Code != http.StatusOK {
		t.Fatalf("statut %d %s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "could not") || strings.Contains(response.Body.String(), "user_not_found") {
		t.Fatalf("existence révélée : %s", response.Body.String())
	}
}

func TestPublicOriginIgnoresSpoofedHost(t *testing.T) {
	server := &Server{cfg: config.Config{}}
	request := httptest.NewRequest(http.MethodPost, "http://api.internal/api/auth/recover", nil)
	request.RemoteAddr = "203.0.113.8:443"
	request.Host = "api.internal"
	request.Header.Set("X-Forwarded-Host", "evil.example")
	request.Header.Set("X-Forwarded-Proto", "https")
	origin, ok := server.publicOrigin(request)
	if !ok || origin != "http://api.internal" {
		t.Fatalf("origin = %q ok=%v", origin, ok)
	}

	local := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:8788/api/auth/recover", nil)
	local.RemoteAddr = "127.0.0.1:3000"
	local.Host = "127.0.0.1:8788"
	local.Header.Set("X-Forwarded-Host", "localhost:3000")
	local.Header.Set("X-Forwarded-Proto", "http")
	origin, ok = server.publicOrigin(local)
	if !ok || origin != "http://localhost:3000" {
		t.Fatalf("origine locale = %q ok=%v", origin, ok)
	}
}

func authServer(t *testing.T, endpoint string) *Server {
	t.Helper()
	return New(config.Config{
		AppwriteEnabled:   true,
		AppwriteEndpoint:  endpoint,
		AppwriteProjectID: "69cedb12002acdd498e0",
		CacheDir:          t.TempDir(),
	})
}

func authRequest(t *testing.T, endpoint, method, path, body, cookie string) *httptest.ResponseRecorder {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	request := httptest.NewRequest(method, path, reader)
	request.RemoteAddr = "203.0.113.8:443"
	request.Host = "docs.enise.test"
	if cookie != "" {
		request.Header.Set("Cookie", cookie)
	}
	response := httptest.NewRecorder()
	if err := authServer(t, endpoint).handleAuth(response, request); err != nil {
		writeError(response, request, err)
	}
	return response
}
