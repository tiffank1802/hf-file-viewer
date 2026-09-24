package appwrite

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// Favorite est une ligne de la table favorites, sans email.
type Favorite struct {
	RowID string `json:"rowId"`
	Path  string `json:"path"`
	Name  string `json:"name"`
	Type  string `json:"type"`
	Note  string `json:"note"`
}

// HasFavorites dit si la table des favoris peut être appelée.
func (c *Client) HasFavorites() bool {
	return c.HasDatabase() && ValidID(firstNonEmpty(c.FavoritesTable, "favorites"))
}

// ListFavorites lit les lignes du compte.
func (c *Client) ListFavorites(ctx context.Context, session, userID string) ([]Favorite, error) {
	if !c.HasFavorites() || !ValidID(userID) {
		return nil, &APIError{Status: http.StatusServiceUnavailable, Type: "not_configured"}
	}
	var last error
	apis := c.favoriteAPIs()
	for i, api := range apis {
		items, err := c.listFavoritesWith(ctx, api, session, userID)
		if err == nil {
			return items, nil
		}
		last = err
		if IsMissingTable(err) || !isRouteMissing(err) || i == len(apis)-1 {
			return nil, err
		}
	}
	return nil, last
}

// CreateFavorite ajoute une ligne. Un doublon de chemin renvoie la ligne existante.
func (c *Client) CreateFavorite(ctx context.Context, session, userID string, item Favorite) (Favorite, error) {
	if !c.HasFavorites() || !ValidID(userID) {
		return Favorite{}, &APIError{Status: http.StatusServiceUnavailable, Type: "not_configured"}
	}
	path, ok := NormalizeFavoritePath(item.Path)
	if !ok {
		return Favorite{}, &APIError{Status: http.StatusBadRequest, Type: "general_argument_invalid"}
	}
	item.Path = path
	if strings.TrimSpace(item.Name) == "" {
		item.Name = path
	}
	data := map[string]any{
		"userId":   userID,
		"filePath": path,
		"pathKey":  PathKey(path),
		"kind":     favoriteKind(item.Type),
		"title":    clip(item.Name, 240),
		"note":     clip(item.Note, 280),
	}
	permissions := ownerPermissions(userID)
	var last error
	for i, api := range c.favoriteAPIs() {
		created, err := c.createFavoriteWith(ctx, api, session, data, permissions)
		if err == nil {
			if created.Path == "" {
				created.Path = path
				created.Name = clip(item.Name, 240)
				created.Type = typeFromKind(favoriteKind(item.Type))
				created.Note = clip(item.Note, 280)
			}
			return created, nil
		}
		if isConflict(err) {
			found, findErr := c.findFavorite(ctx, api, session, userID, path)
			if findErr == nil && found.RowID != "" {
				return found, nil
			}
		}
		last = err
		if IsMissingTable(err) || !isRouteMissing(err) || i == len(c.favoriteAPIs())-1 {
			return Favorite{}, err
		}
	}
	return Favorite{}, last
}

// DeleteFavorite retire une ligne. Une ligne déjà absente n'est pas une erreur.
func (c *Client) DeleteFavorite(ctx context.Context, session, userID, rowID, path string) error {
	if !c.HasFavorites() || !ValidID(userID) {
		return &APIError{Status: http.StatusServiceUnavailable, Type: "not_configured"}
	}
	if rowID != "" && !ValidID(rowID) {
		return &APIError{Status: http.StatusBadRequest, Type: "general_argument_invalid"}
	}
	var last error
	apis := c.favoriteAPIs()
	for i, api := range apis {
		target := rowID
		if target == "" {
			found, err := c.findFavorite(ctx, api, session, userID, path)
			if err != nil {
				last = err
				if isRouteMissing(err) && i < len(apis)-1 {
					continue
				}
				return err
			}
			target = found.RowID
		}
		if target == "" {
			return nil
		}
		_, err := c.do(ctx, http.MethodDelete, fmt.Sprintf(api.get, url.PathEscape(target)), session, nil)
		if err == nil || isMissingRow(err) {
			return nil
		}
		last = err
		if IsMissingTable(err) || !isRouteMissing(err) || i == len(apis)-1 {
			return err
		}
	}
	return last
}

// UpdateFavoriteNote écrit la note du propriétaire.
func (c *Client) UpdateFavoriteNote(ctx context.Context, session, rowID, note string) error {
	if !c.HasFavorites() || !ValidID(rowID) {
		return &APIError{Status: http.StatusBadRequest, Type: "general_argument_invalid"}
	}
	body := map[string]any{"data": map[string]any{"note": clip(note, 280)}}
	var last error
	apis := c.favoriteAPIs()
	for i, api := range apis {
		_, err := c.do(ctx, http.MethodPatch, fmt.Sprintf(api.update, url.PathEscape(rowID)), session, body)
		if err == nil {
			return nil
		}
		last = err
		if IsMissingTable(err) || !isRouteMissing(err) || i == len(apis)-1 {
			return err
		}
	}
	return last
}

func (c *Client) favoriteAPIs() []dataAPI {
	db := url.PathEscape(c.DatabaseID)
	table := url.PathEscape(firstNonEmpty(c.FavoritesTable, "favorites"))
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

func (c *Client) listFavoritesWith(ctx context.Context, api dataAPI, session, userID string) ([]Favorite, error) {
	result, err := c.do(ctx, http.MethodGet, favoriteListPath(api.create, userID), session, nil)
	if err != nil {
		return nil, err
	}
	return favoritesFrom(result.Body, userID), nil
}

func (c *Client) createFavoriteWith(ctx context.Context, api dataAPI, session string, data map[string]any, permissions []string) (Favorite, error) {
	rowID, err := newRowID()
	if err != nil {
		return Favorite{}, err
	}
	result, err := c.do(ctx, http.MethodPost, api.create, session, map[string]any{
		api.idKey:     rowID,
		"data":        data,
		"permissions": permissions,
	})
	if err != nil {
		return Favorite{}, err
	}
	items := favoritesFrom(result.Body, "")
	if len(items) == 1 && items[0].Path != "" {
		if items[0].RowID == "" {
			items[0].RowID = rowID
		}
		return items[0], nil
	}
	return Favorite{
		RowID: rowID,
		Path:  asString(data["filePath"]),
		Name:  asString(data["title"]),
		Type:  typeFromKind(asString(data["kind"])),
		Note:  asString(data["note"]),
	}, nil
}

func (c *Client) findFavorite(ctx context.Context, api dataAPI, session, userID, path string) (Favorite, error) {
	normalized, ok := NormalizeFavoritePath(path)
	if !ok {
		return Favorite{}, nil
	}
	items, err := c.listFavoritesWith(ctx, api, session, userID)
	if err != nil {
		return Favorite{}, err
	}
	for _, item := range items {
		if item.Path == normalized {
			return item, nil
		}
	}
	return Favorite{}, nil
}

func favoriteListPath(createPath, userID string) string {
	values := url.Values{}
	values.Add("queries[]", fmt.Sprintf(`equal("userId",["%s"])`, userID))
	values.Add("queries[]", "limit(200)")
	return createPath + "?" + values.Encode()
}

func favoritesFrom(raw []byte, userID string) []Favorite {
	var payload map[string]any
	if json.Unmarshal(raw, &payload) != nil {
		return nil
	}
	rows, _ := payload["rows"].([]any)
	if rows == nil {
		rows, _ = payload["documents"].([]any)
	}
	if rows == nil {
		if item := favoriteFromMap(payload); item.Path != "" {
			return []Favorite{item}
		}
		return nil
	}
	items := make([]Favorite, 0, len(rows))
	for _, rawRow := range rows {
		row, _ := rawRow.(map[string]any)
		item := favoriteFromMap(row)
		if item.Path == "" {
			continue
		}
		owner := firstString(row, mapData(row), "userId")
		if userID != "" && owner != "" && owner != userID {
			continue
		}
		items = append(items, item)
	}
	return items
}

func favoriteFromMap(row map[string]any) Favorite {
	if row == nil {
		return Favorite{}
	}
	nested := mapData(row)
	path, _ := NormalizeFavoritePath(firstString(row, nested, "filePath"))
	if path == "" {
		path, _ = NormalizeFavoritePath(firstString(row, nested, "path"))
	}
	return Favorite{
		RowID: firstString(row, nil, "$id"),
		Path:  path,
		Name:  firstNonEmpty(firstString(row, nested, "title"), path),
		Type:  typeFromKind(firstString(row, nested, "kind")),
		Note:  firstString(row, nested, "note"),
	}
}

func mapData(row map[string]any) map[string]any {
	nested, _ := row["data"].(map[string]any)
	return nested
}

func typeFromKind(kind string) string {
	if kind == "folder" {
		return "directory"
	}
	return "file"
}

func favoriteKind(itemType string) string {
	if itemType == "directory" || itemType == "folder" {
		return "folder"
	}
	return "file"
}

func asString(value any) string {
	text, _ := value.(string)
	return text
}

func ownerPermissions(userID string) []string {
	return []string{
		`read("user:` + userID + `")`,
		`update("user:` + userID + `")`,
		`delete("user:` + userID + `")`,
	}
}

// PathKey reprend les 16 premiers octets SHA-256 du chemin, comme l'autre branche.
func PathKey(path string) string {
	sum := sha256.Sum256([]byte(path))
	return hex.EncodeToString(sum[:16])
}

// NormalizeFavoritePath aligne le chemin sur celui stocké dans la table.
func NormalizeFavoritePath(path string) (string, bool) {
	path = strings.TrimSpace(path)
	path = strings.ReplaceAll(path, "\\", "/")
	for strings.Contains(path, "//") {
		path = strings.ReplaceAll(path, "//", "/")
	}
	path = strings.Trim(path, "/")
	if path == "" || len(path) > 1024 || strings.Contains(path, "..") {
		return "", false
	}
	for _, r := range path {
		if r < 32 || r == 127 {
			return "", false
		}
	}
	return path, true
}

// IsMissingTable dit si la table ou la collection n'a pas encore été créée.
func IsMissingTable(err error) bool {
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr == nil {
		return false
	}
	switch apiErr.Type {
	case "table_not_found", "collection_not_found":
		return true
	default:
		return false
	}
}

func newRowID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf)[:20], nil
}
