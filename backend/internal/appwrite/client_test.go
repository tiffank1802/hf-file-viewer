package appwrite

import (
	"net/http"
	"testing"
)

func TestSessionSecretPrefersProjectCookie(t *testing.T) {
	cookies := []*http.Cookie{
		{Name: "a_session_other", Value: "autre"},
		{Name: "a_session_proj_legacy", Value: "ancien"},
		{Name: "a_session_proj", Value: "bonsecret"},
	}
	if got := SessionSecret("proj", cookies, []byte(`{"secret":"json"}`)); got != "bonsecret" {
		t.Fatalf("secret = %q", got)
	}
	if got := SessionSecret("proj", nil, []byte(`{"secret":"jsonsecret"}`)); got != "jsonsecret" {
		t.Fatalf("secret json = %q", got)
	}
}

func TestFrenchDoesNotEchoUpstreamMessage(t *testing.T) {
	err := &APIError{Status: http.StatusUnauthorized, Type: "user_invalid_credentials", Detail: "password=secret"}
	if got := French(err); got != "Email ou mot de passe incorrect." {
		t.Fatalf("message = %q", got)
	}
	if got := French(&APIError{Status: 500, Type: "password=secret"}); got == "password=secret" || got == "" {
		t.Fatalf("type dangereux recopié : %q", got)
	}
}

func TestValidEndpointRejectsPlainHTTP(t *testing.T) {
	if ValidEndpoint("http://fra.cloud.appwrite.io/v1") {
		t.Fatal("http public accepté")
	}
	if !ValidEndpoint("https://fra.cloud.appwrite.io/v1") {
		t.Fatal("https refusé")
	}
	if !ValidEndpoint("http://127.0.0.1:18080") {
		t.Fatal("boucle locale refusée")
	}
}
