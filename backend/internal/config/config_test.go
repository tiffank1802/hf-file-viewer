package config

import (
	"path/filepath"
	"testing"
)

func TestAppwriteFallsBackToViteNamesAndCanBeDisabled(t *testing.T) {
	t.Setenv("APPWRITE_ENABLED", "0")
	t.Setenv("VITE_APPWRITE_DATABASE_ID", "db123")
	t.Setenv("DEV_VARS", filepath.Join(t.TempDir(), "missing"))
	cfg := Load(t.TempDir())
	if cfg.AppwriteEnabled {
		t.Fatal("compte encore activé")
	}
	if cfg.AppwriteDatabaseID != "db123" {
		t.Fatalf("base = %q", cfg.AppwriteDatabaseID)
	}
	if cfg.AppwriteProjectID != "69cedb12002acdd498e0" {
		t.Fatalf("projet = %q", cfg.AppwriteProjectID)
	}
}

func TestNVIDIAPlaceholderIsUnset(t *testing.T) {
	t.Setenv("NVIDIA_API_KEY", "nvapi-your-key")
	t.Setenv("NVIDIA_MODEL", "")
	t.Setenv("DEV_VARS", filepath.Join(t.TempDir(), "missing"))
	cfg := Load(t.TempDir())
	if cfg.NvidiaAPIKey != "" {
		t.Fatalf("placeholder conservé: %q", cfg.NvidiaAPIKey)
	}
	if cfg.NvidiaModel != "meta/llama-3.1-8b-instruct" {
		t.Fatalf("modèle = %q", cfg.NvidiaModel)
	}
	if cfg.NvidiaAPIBase != "https://integrate.api.nvidia.com/v1" {
		t.Fatalf("base = %q", cfg.NvidiaAPIBase)
	}
}
