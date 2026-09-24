package chat

import (
	"strings"
	"testing"

	"enise-docs/backend/internal/catalog"
)

func TestRankPrefersSubjectAndAccent(t *testing.T) {
	items := []catalog.BucketItem{
		{Type: "file", Path: "TOEIC/listening.mp3"},
		{Type: "file", Path: "GM/3A GM/S5/Mecanique/poly.pdf"},
		{Type: "directory", Path: "GM/4A GM"},
	}
	hits := Rank(items, "Où est le poly de mécanique en 3A ?", "", 5)
	if len(hits) == 0 || hits[0].Path != "GM/3A GM/S5/Mecanique/poly.pdf" {
		t.Fatalf("classement = %+v", hits)
	}
	if hits[0].Name != "poly.pdf" {
		t.Fatalf("nom = %s", hits[0].Name)
	}
}

func TestRankBoostsCurrentFolder(t *testing.T) {
	items := []catalog.BucketItem{
		{Type: "file", Path: "GM/4A GM/anglais.pdf"},
		{Type: "file", Path: "GM/3A GM/S5/English/anglais.pdf"},
	}
	hits := Rank(items, "anglais", "GM/3A GM", 5)
	if len(hits) < 2 || hits[0].Path != "GM/3A GM/S5/English/anglais.pdf" {
		t.Fatalf("classement = %+v", hits)
	}
}

func TestRankRequiresUsefulTokens(t *testing.T) {
	items := []catalog.BucketItem{{Type: "file", Path: "GM/cours.pdf"}}
	if hits := Rank(items, "le la les", "", 5); hits != nil {
		t.Fatalf("résultats inattendus: %+v", hits)
	}
}

func TestExpandForReadingOpensAFileInsideTheFolder(t *testing.T) {
	items := []catalog.BucketItem{
		{Type: "directory", Path: "GM/Tutos SolidWorks"},
		{Type: "file", Path: "GM/Tutos SolidWorks/intro.pdf"},
		{Type: "file", Path: "TOEIC/listening.mp3"},
	}
	hits := Rank(items, "tutos solidworks", "", 5)
	if len(hits) == 0 || hits[0].Type != "directory" {
		t.Fatalf("classement = %+v", hits)
	}
	expanded := ExpandForReading(items, hits, 6)
	if len(expanded) == 0 || expanded[0].Path != "GM/Tutos SolidWorks/intro.pdf" {
		t.Fatalf("expansion = %+v", expanded)
	}
}

func TestTokensFoldApostrophe(t *testing.T) {
	tokens := Tokens("l'épreuve d'anglais")
	if len(tokens) != 2 || tokens[0] != "epreuve" || tokens[1] != "anglais" {
		t.Fatalf("tokens = %#v", tokens)
	}
}

func TestQuestionProfileDetectsStructureQuestions(t *testing.T) {
	structure := QuestionProfile("comment se structure l’examen d’économie ?")
	if !structure.Synthesis {
		t.Fatalf("profil synthèse attendu: %+v", structure)
	}
	if structure.MaxRead < 3 {
		t.Fatalf("une synthèse doit lire plusieurs documents: %+v", structure)
	}
	simple := QuestionProfile("où sont les polys de mécanique ?")
	if simple.Synthesis {
		t.Fatalf("profil synthèse inattendu: %+v", simple)
	}
}

func TestRelatedDocumentsGathersTheSameFolder(t *testing.T) {
	items := []catalog.BucketItem{
		{Type: "file", Path: "GM/Economie/DS 2022.pdf"},
		{Type: "file", Path: "GM/Economie/DS 2023.pdf"},
		{Type: "file", Path: "GM/Economie/DS 2024.pdf"},
		{Type: "file", Path: "TOEIC/listening.mp3"},
	}
	hits := Rank(items, "examen économie", "", 4)
	if len(hits) == 0 {
		t.Fatal("aucun document classé")
	}
	related := RelatedDocuments(items, hits, 3)
	if len(related) == 0 {
		t.Fatal("aucun voisin proposé")
	}
	for _, hit := range related {
		if !strings.HasPrefix(hit.Path, "GM/Economie/") {
			t.Fatalf("voisin hors du dossier: %s", hit.Path)
		}
	}
}

func TestTokenScorePrefersWholeWords(t *testing.T) {
	if tokenScore("seance", "se") != 0 {
		t.Fatal("« se » ne doit plus correspondre à l’intérieur d’un mot")
	}
	if tokenScore("ds economie 2023", "economie") == 0 {
		t.Fatal("mot entier non reconnu")
	}
	if tokenScore("gm/3agm/s5", "3a") == 0 {
		t.Fatal("préfixe court non reconnu")
	}
}
