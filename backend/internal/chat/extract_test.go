package chat

import (
	"archive/zip"
	"bytes"
	"compress/zlib"
	"strings"
	"testing"
)

func TestExtractPlainAndDocx(t *testing.T) {
	plain := Extract("note.md", []byte("Bilan de conception\n\nchapitre 1"), 80)
	if plain != "Bilan de conception chapitre 1" {
		t.Fatalf("texte = %q", plain)
	}
	docx := Extract("cours.docx", zipWith(t, "word/document.xml", `<w:document><w:t>Résistance &amp; matériaux</w:t></w:document>`), 80)
	if !strings.Contains(docx, "Résistance & matériaux") {
		t.Fatalf("docx = %q", docx)
	}
	if Extract("photo.png", []byte("pas un texte utile ici"), 40) != "" {
		t.Fatal("un png ne doit pas être lu comme un document")
	}
}

func TestExtractPDFLiteralAndFlate(t *testing.T) {
	raw := []byte("%PDF-1.4\n1 0 obj\n<< /Length 44 >>\nstream\nBT (Mecanique des fluides) Tj ET\nendstream\nendobj\n")
	if text := Extract("poly.pdf", raw, 80); !strings.Contains(text, "Mecanique des fluides") {
		t.Fatalf("pdf brut = %q", text)
	}

	var compressed bytes.Buffer
	writer := zlib.NewWriter(&compressed)
	if _, err := writer.Write([]byte("BT (Resistance des materiaux) Tj ET")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	stream := compressed.Bytes()
	pdf := []byte("%PDF-1.4\n1 0 obj\n<< /Filter /FlateDecode /Length 1 >>\nstream\n")
	pdf = append(pdf, stream...)
	pdf = append(pdf, []byte("\nendstream\nendobj\n")...)
	if text := Extract("poly.pdf", pdf, 80); !strings.Contains(text, "Resistance des materiaux") {
		t.Fatalf("pdf compressé = %q", text)
	}
}

func zipWith(t *testing.T, name, content string) []byte {
	t.Helper()
	var buf bytes.Buffer
	writer := zip.NewWriter(&buf)
	file, err := writer.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte(content)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// Un PDF dont les polices sont encodées par glyphes donne une table de
// caractères, pas du texte : mieux vaut ne rien renvoyer que du bruit.
func TestExtractRefusesGlyphNoise(t *testing.T) {
	noise := "E:\\LEAP ENGLISH CENTRE *Asus lap\\Mẫu thiết kế\\LEAP-Header. png Adobe UCS ÿÿ A B D I E N W P s V a à b d e è f g h i í j k l m o p r s t u ù v y 1 +1:? AHLTVY` ­´àèíóùăđ"
	if text := Extract("lesson.pdf", []byte(noise), 400); text != "" {
		t.Fatalf("bruit conservé: %q", text)
	}
	if text := Extract("lesson.txt", []byte("Le DS d’économie comporte trois parties et une étude de document."), 400); text == "" {
		t.Fatal("un texte propre ne doit pas être écarté")
	}
	if text := Extract("note.txt", []byte("Bilan de conception du banc d’essai."), 400); text == "" {
		t.Fatal("un texte court ne doit pas être écarté")
	}
}
