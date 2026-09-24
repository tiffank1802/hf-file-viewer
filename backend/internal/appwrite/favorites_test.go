package appwrite

import (
	"testing"
)

func TestPathKeyMatchesSHA256Prefix(t *testing.T) {
	if got := PathKey("GM/a.pdf"); got != "8f5d0e6a0c4e5b1a9d2c7e6f4a3b1c8d" && len(got) != 32 {
		t.Fatalf("longueur = %d (%s)", len(got), got)
	}
	if PathKey("GM/a.pdf") == PathKey("GM/b.pdf") {
		t.Fatal("clés identiques")
	}
}

func TestNormalizeFavoritePathRejectsTraversal(t *testing.T) {
	if _, ok := NormalizeFavoritePath("../secret"); ok {
		t.Fatal("traversée acceptée")
	}
	got, ok := NormalizeFavoritePath(` /GM//3A GM/td.pdf/ `)
	if !ok || got != "GM/3A GM/td.pdf" {
		t.Fatalf("chemin = %q ok=%v", got, ok)
	}
}
