package config

import (
	"bufio"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"enise-docs/backend/internal/catalog"
)

const (
	defaultBucketID       = "ktongue/ENISE-SITE"
	defaultHFOrigin       = "https://huggingface.co"
	defaultModel3DURL     = "https://ktongue-rupture.hf.space"
	defaultAddr           = "0.0.0.0:8788"
	defaultTreeTTL        = 6 * time.Hour
	defaultIndexTTL       = 12 * time.Hour
	defaultFileTTL        = 7 * 24 * time.Hour
	defaultOfficeTTL      = 7 * 24 * time.Hour
	defaultModelTTL       = 7 * 24 * time.Hour
	defaultLinkTTL        = 24 * time.Hour
	defaultApsTTL         = 24 * time.Hour
	defaultMaxFileBytes   = 25 * 1024 * 1024
	defaultMaxOfficeBytes = 25 * 1024 * 1024
	defaultMaxModelBytes  = 25 * 1024 * 1024
	defaultMaxApsBytes    = 100 * 1024 * 1024
	defaultMaxSWBytes     = 100 * 1024 * 1024
	defaultMaxSWFiles     = 64
	defaultMaxSWBundle    = 250 * 1024 * 1024
	defaultNvidiaBase     = "https://integrate.api.nvidia.com/v1"
	defaultNvidiaModel    = "meta/llama-3.1-8b-instruct"
	defaultAppwriteURL    = "https://fra.cloud.appwrite.io/v1"
	defaultAppwriteProj   = "69cedb12002acdd498e0"

	// Les modèles qui raisonnent consomment leur budget de jetons avant
	// d’écrire la réponse : 1100 jetons ne laissaient rien pour la réponse
	// visible (finish_reason "length", contenu vide).
	defaultChatAnswerTimeout = 150 * time.Second
	defaultChatMaxTokens     = 4096
	defaultChatDeepTokens    = 8192
)

// Config rassemble les mêmes variables que le Worker Cloudflare.
// Les secrets restent côté processus : le navigateur ne les voit jamais.
type Config struct {
	Addr       string
	Root       string
	StaticDir  string
	CacheDir   string
	HFOrigin   string
	BucketID   string
	HFToken    string
	TreeTTL    time.Duration
	IndexTTL   time.Duration
	FileTTL    time.Duration
	StaleGrace time.Duration

	MaxCacheableFileBytes int64
	OfficeConvertURL      string
	OfficePDFTTL          time.Duration
	MaxOfficeBytes        int64
	Model3DConvertURL     string
	Model3DTTL            time.Duration
	MaxModel3DBytes       int64
	LinkPreviewTTL        time.Duration

	ApsClientID     string
	ApsClientSecret string
	ApsBucketKey    string
	ApsTTL          time.Duration
	MaxApsBytes     int64

	SolidworksConvertURL string
	SolidworksToken      string
	MaxSolidworksBytes   int64
	MaxSolidworksFiles   int
	MaxSolidworksBundle  int64

	NvidiaAPIKey      string
	NvidiaAPIBase     string
	NvidiaModel       string
	ChatAnswerTimeout time.Duration
	ChatMaxTokens     int
	ChatDeepTokens    int
	OpenRouterAPIKey  string
	OpenRouterAPIBase string
	OpenRouterModel   string
	OpenCodeAPIKey    string
	OpenCodeAPIBase   string
	OpenCodeModel     string
	ChatTrustProxy    bool

	AppwriteEnabled            bool
	AppwriteEndpoint           string
	AppwriteProjectID          string
	AppwriteDatabaseID         string
	AppwriteProfileTable       string
	AppwriteFavoritesTable     string
	AppwriteConversationsTable string
	AppwriteMessagesTable      string
	AppwriteFlavor             string
	AppwritePublicOrigin       string
}

func Load(root string) Config {
	if root == "" {
		root, _ = os.Getwd()
	}
	fileValues := readDevVars(root)
	lookup := func(key string) (string, bool) {
		if value, ok := os.LookupEnv(key); ok && strings.TrimSpace(value) != "" {
			return value, true
		}
		value, ok := fileValues[key]
		return value, ok
	}
	get := func(key string) string {
		value, _ := lookup(key)
		return strings.TrimSpace(value)
	}

	cfg := Config{
		Addr:                  firstNonEmpty(os.Getenv("ADDR"), addrFromPort(os.Getenv("PORT")), defaultAddr),
		Root:                  root,
		StaticDir:             get("STATIC_DIR"),
		CacheDir:              firstNonEmpty(get("CACHE_DIR"), filepath.Join(root, ".cache", "go-api")),
		HFOrigin:              firstNonEmpty(get("HF_ORIGIN"), defaultHFOrigin),
		BucketID:              firstNonEmpty(get("HF_BUCKET_ID"), defaultBucketID),
		HFToken:               unsetPlaceholder(get("HF_TOKEN")),
		TreeTTL:               durationSeconds(get("TREE_CACHE_TTL"), defaultTreeTTL),
		IndexTTL:              durationSeconds(get("INDEX_CACHE_TTL"), defaultIndexTTL),
		FileTTL:               durationSeconds(get("FILE_CACHE_TTL"), defaultFileTTL),
		StaleGrace:            24 * time.Hour,
		MaxCacheableFileBytes: int64(catalog.PositiveInt(get("MAX_CACHEABLE_FILE_BYTES"), defaultMaxFileBytes)),
		OfficePDFTTL:          durationSeconds(get("OFFICE_PDF_CACHE_TTL"), defaultOfficeTTL),
		MaxOfficeBytes:        int64(catalog.PositiveInt(get("MAX_OFFICE_CONVERT_BYTES"), defaultMaxOfficeBytes)),
		Model3DTTL:            durationSeconds(get("MODEL3D_CACHE_TTL"), defaultModelTTL),
		MaxModel3DBytes:       int64(catalog.PositiveInt(get("MAX_MODEL3D_BYTES"), defaultMaxModelBytes)),
		LinkPreviewTTL:        durationSeconds(get("LINK_PREVIEW_CACHE_TTL"), defaultLinkTTL),
		ApsClientID:           unsetPlaceholder(get("APS_CLIENT_ID")),
		ApsClientSecret:       unsetPlaceholder(get("APS_CLIENT_SECRET")),
		ApsBucketKey:          strings.ToLower(get("APS_BUCKET_KEY")),
		ApsTTL:                durationSeconds(get("APS_CACHE_TTL"), defaultApsTTL),
		MaxApsBytes:           int64(catalog.PositiveInt(get("MAX_APS_UPLOAD_BYTES"), defaultMaxApsBytes)),
		SolidworksToken:       unsetPlaceholder(get("SOLIDWORKS_CONVERTER_TOKEN")),
		MaxSolidworksBytes:    int64(catalog.PositiveInt(get("MAX_SOLIDWORKS_BYTES"), defaultMaxSWBytes)),
		MaxSolidworksFiles:    catalog.PositiveInt(get("MAX_SOLIDWORKS_DEPENDENCY_FILES"), defaultMaxSWFiles),
		MaxSolidworksBundle:   int64(catalog.PositiveInt(get("MAX_SOLIDWORKS_BUNDLE_BYTES"), defaultMaxSWBundle)),
	}
	if value, ok := lookup("OFFICE_CONVERT_URL"); ok {
		cfg.OfficeConvertURL = catalog.TrimTrailingSlashes(value)
	}
	if value, ok := lookup("MODEL3D_CONVERT_URL"); ok {
		cfg.Model3DConvertURL = catalog.TrimTrailingSlashes(value)
	} else {
		cfg.Model3DConvertURL = defaultModel3DURL
	}
	if value, ok := lookup("SOLIDWORKS_CONVERT_URL"); ok {
		cfg.SolidworksConvertURL = catalog.TrimTrailingSlashes(value)
	}
	if !catalog.ValidBucketID(cfg.BucketID) {
		cfg.BucketID = defaultBucketID
	}
	cfg.NvidiaAPIKey = unsetPlaceholder(firstNonEmpty(get("NVIDIA_API_KEY"), get("NVIDIA_NIM_API_KEY")))
	cfg.NvidiaAPIBase = catalog.TrimTrailingSlashes(firstNonEmpty(get("NVIDIA_API_BASE"), defaultNvidiaBase))
	cfg.NvidiaModel = firstNonEmpty(sanitizeModel(get("NVIDIA_MODEL")), defaultNvidiaModel)
	cfg.OpenRouterAPIKey = unsetPlaceholder(firstNonEmpty(get("OPENROUTER_API_KEY"), get("OPENROUTER_KEY")))
	cfg.OpenRouterAPIBase = catalog.TrimTrailingSlashes(firstNonEmpty(get("OPENROUTER_API_BASE"), "https://openrouter.ai/api/v1"))
	cfg.OpenRouterModel = firstNonEmpty(sanitizeModel(get("OPENROUTER_MODEL")), "meta-llama/llama-3.3-70b-instruct")
	cfg.OpenCodeAPIKey = unsetPlaceholder(firstNonEmpty(get("OPENCODE_API_KEY"), get("OPENCODE_ZEN_API_KEY")))
	cfg.OpenCodeAPIBase = catalog.TrimTrailingSlashes(firstNonEmpty(get("OPENCODE_API_BASE"), "https://opencode.ai/zen/v1"))
	cfg.OpenCodeModel = firstNonEmpty(sanitizeModel(get("OPENCODE_MODEL")), "nemotron-3-ultra-free")
	cfg.ChatAnswerTimeout = durationSeconds(get("CHAT_ANSWER_TIMEOUT"), defaultChatAnswerTimeout)
	cfg.ChatMaxTokens = catalog.PositiveInt(get("CHAT_MAX_TOKENS"), defaultChatMaxTokens)
	cfg.ChatDeepTokens = catalog.PositiveInt(get("CHAT_DEEP_MAX_TOKENS"), defaultChatDeepTokens)
	cfg.ChatTrustProxy = truthy(get("CHAT_TRUST_PROXY"))
	cfg.AppwriteEndpoint = catalog.TrimTrailingSlashes(firstNonEmpty(get("APPWRITE_ENDPOINT"), get("VITE_APPWRITE_ENDPOINT"), defaultAppwriteURL))
	cfg.AppwriteProjectID = firstNonEmpty(get("APPWRITE_PROJECT_ID"), get("VITE_APPWRITE_PROJECT_ID"), defaultAppwriteProj)
	cfg.AppwriteDatabaseID = firstNonEmpty(get("APPWRITE_DATABASE_ID"), get("VITE_APPWRITE_DATABASE_ID"), "enise_docs")
	cfg.AppwriteProfileTable = firstNonEmpty(get("APPWRITE_PROFILE_TABLE_ID"), get("VITE_APPWRITE_PROFILE_TABLE_ID"), "profiles")
	cfg.AppwriteFavoritesTable = firstNonEmpty(get("APPWRITE_FAVORITES_TABLE_ID"), get("VITE_APPWRITE_FAVORITES_TABLE_ID"), "favorites")
	cfg.AppwriteConversationsTable = firstNonEmpty(get("APPWRITE_CONVERSATIONS_TABLE_ID"), "conversations")
	cfg.AppwriteMessagesTable = firstNonEmpty(get("APPWRITE_MESSAGES_TABLE_ID"), "messages")
	cfg.AppwritePublicOrigin = strings.TrimSpace(get("APPWRITE_PUBLIC_ORIGIN"))
	cfg.AppwriteFlavor = "tablesdb"
	if strings.EqualFold(firstNonEmpty(get("APPWRITE_FLAVOR"), get("VITE_APPWRITE_FLAVOR")), "databases") {
		cfg.AppwriteFlavor = "databases"
	}
	cfg.AppwriteEnabled = true
	if value, ok := lookup("APPWRITE_ENABLED"); ok && falsy(value) {
		cfg.AppwriteEnabled = false
	}
	return cfg
}

func addrFromPort(port string) string {
	port = strings.TrimSpace(port)
	if port == "" {
		return ""
	}
	if _, err := strconv.Atoi(port); err != nil {
		return ""
	}
	return "0.0.0.0:" + port
}

func durationSeconds(value string, fallback time.Duration) time.Duration {
	seconds := catalog.PositiveInt(value, 0)
	if seconds == 0 {
		return fallback
	}
	return time.Duration(seconds) * time.Second
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func unsetPlaceholder(value string) string {
	switch strings.TrimSpace(value) {
	case "", "hf_your_read_only_token", "your_aps_client_id", "your_aps_client_secret", "secret-partage-avec-le-service",
		"nvapi-your-key", "nvapi-votre-cle", "nvapi-VOTRE_CLE",
		"sk-or-v1-your-key", "sk-or-votre-cle", "opencode-your-key":
		return ""
	default:
		return strings.TrimSpace(value)
	}
}

func readDevVars(root string) map[string]string {
	values := map[string]string{}
	candidates := []string{
		os.Getenv("DEV_VARS"),
		filepath.Join(root, ".dev.vars"),
		filepath.Join(root, "..", ".dev.vars"),
	}
	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		file, err := os.Open(candidate)
		if err != nil {
			continue
		}
		scanner := bufio.NewScanner(file)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			line = strings.TrimPrefix(line, "export ")
			key, value, ok := strings.Cut(line, "=")
			if !ok {
				continue
			}
			key = strings.TrimSpace(key)
			value = strings.TrimSpace(value)
			if len(value) >= 2 && value[0] == '"' && value[len(value)-1] == '"' {
				value = value[1 : len(value)-1]
			}
			if key != "" {
				values[key] = value
			}
		}
		file.Close()
		return values
	}
	return values
}

func (c Config) ApsConfigured() bool {
	return c.ApsClientID != "" && c.ApsClientSecret != ""
}

func sanitizeModel(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 120 {
		return ""
	}
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '/' || r == '.' || r == '_' || r == '-' || r == ':':
		default:
			return ""
		}
	}
	return value
}

func truthy(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func falsy(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "0", "false", "no", "off":
		return true
	default:
		return false
	}
}
