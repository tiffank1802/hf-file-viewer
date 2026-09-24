package config

import (
	"path/filepath"
	"testing"
)

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
