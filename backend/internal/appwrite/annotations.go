package appwrite

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
)

const annotationListLimit = 100

// Annotation est une ligne privée du lecteur interactif.
type Annotation struct {
	RowID       string `json:"rowId"`
	UserID      string `json:"-"`
	DocumentKey string `json:"documentKey"`
	SourcePath  string `json:"sourcePath"`
	ArtifactID  string `json:"artifactId"`
	BlockID     string `json:"blockId,omitempty"`
	Page        int    `json:"page,omitempty"`
	AnchorJSON  string `json:"anchorJson"`
	Kind        string `json:"kind"`
	Color       string `json:"color"`
	Body        string `json:"body,omitempty"`
	Status      string `json:"status"`
	CreatedAt   string `json:"createdAt,omitempty"`
	UpdatedAt   string `json:"updatedAt,omitempty"`
}

// AnnotationPatch borne les seuls champs mutables après la création de l'ancre.
type AnnotationPatch struct {
	Body   *string
	Color  *string
	Status *string
}

func (c *Client) HasAnnotations() bool {
	return c.HasDatabase() && ValidID(firstNonEmpty(c.AnnotationsTable, "annotations"))
}

func (c *Client) ListAnnotations(ctx context.Context, session, userID, documentKey string) ([]Annotation, error) {
	if !c.HasAnnotations() || !ValidID(userID) || !validDocumentKey(documentKey) {
		return nil, &APIError{Status: http.StatusServiceUnavailable, Type: "not_configured"}
	}
	var last error
	apis := c.tableAPIs(c.AnnotationsTable)
	for i, api := range apis {
		items, err := c.listAnnotationsAt(ctx, api, session, userID, documentKey, true)
		if err == nil {
			return items, nil
		}
		if isSkippableAnnotationQuery(err) {
			items, fallbackErr := c.listAnnotationsAt(ctx, api, session, userID, documentKey, false)
			if fallbackErr == nil {
				return items, nil
			}
		}
		last = err
		if IsMissingTable(err) || !isRouteMissing(err) || i == len(apis)-1 {
			return nil, err
		}
	}
	return nil, last
}

func (c *Client) CreateAnnotation(ctx context.Context, session, userID string, item Annotation) (Annotation, error) {
	if !c.HasAnnotations() || !ValidID(userID) || !validDocumentKey(item.DocumentKey) {
		return Annotation{}, &APIError{Status: http.StatusServiceUnavailable, Type: "not_configured"}
	}
	data := annotationData(userID, item)
	permissions := ownerPermissions(userID)
	var last error
	apis := c.tableAPIs(c.AnnotationsTable)
	for i, api := range apis {
		created, err := c.createAnnotationAt(ctx, api, session, data, permissions)
		if err == nil {
			return created, nil
		}
		last = err
		if IsMissingTable(err) || !isRouteMissing(err) || i == len(apis)-1 {
			return Annotation{}, err
		}
	}
	return Annotation{}, last
}

func (c *Client) UpdateAnnotation(ctx context.Context, session, userID, rowID string, patch AnnotationPatch) (Annotation, error) {
	if !c.HasAnnotations() || !ValidID(userID) || !ValidID(rowID) {
		return Annotation{}, &APIError{Status: http.StatusBadRequest, Type: "general_argument_invalid"}
	}
	data := map[string]any{}
	if patch.Body != nil {
		data["body"] = clip(*patch.Body, 4000)
	}
	if patch.Color != nil {
		data["color"] = clip(*patch.Color, 16)
	}
	if patch.Status != nil {
		data["status"] = clip(*patch.Status, 24)
	}
	if len(data) == 0 {
		return Annotation{}, &APIError{Status: http.StatusBadRequest, Type: "general_argument_invalid"}
	}
	var last error
	apis := c.tableAPIs(c.AnnotationsTable)
	for i, api := range apis {
		current, err := c.getOwnedAnnotation(ctx, api, session, userID, rowID)
		if err != nil {
			last = err
			if isRouteMissing(err) && i < len(apis)-1 {
				continue
			}
			return Annotation{}, err
		}
		result, err := c.do(ctx, http.MethodPatch, fmtRow(api.update, rowID), session, map[string]any{"data": data})
		if err == nil {
			updated := annotationFromPayload(result.Body)
			if updated.RowID == "" || updated.SourcePath == "" || updated.AnchorJSON == "" {
				updated = current
				applyAnnotationPatch(&updated, patch)
			}
			return updated, nil
		}
		last = err
		if IsMissingTable(err) || !isRouteMissing(err) || i == len(apis)-1 {
			return Annotation{}, err
		}
	}
	return Annotation{}, last
}

func (c *Client) DeleteAnnotation(ctx context.Context, session, userID, rowID string) error {
	if !c.HasAnnotations() || !ValidID(userID) || !ValidID(rowID) {
		return &APIError{Status: http.StatusBadRequest, Type: "general_argument_invalid"}
	}
	var last error
	apis := c.tableAPIs(c.AnnotationsTable)
	for i, api := range apis {
		if _, err := c.getOwnedAnnotation(ctx, api, session, userID, rowID); err != nil {
			last = err
			if isRouteMissing(err) && i < len(apis)-1 {
				continue
			}
			return err
		}
		_, err := c.do(ctx, http.MethodDelete, fmtRow(api.get, rowID), session, nil)
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

func (c *Client) listAnnotationsAt(ctx context.Context, api dataAPI, session, userID, documentKey string, filtered bool) ([]Annotation, error) {
	queries := []appwriteQuery{{Method: "limit", Values: []any{annotationListLimit}}}
	if filtered {
		queries = append([]appwriteQuery{
			{Method: "equal", Attribute: "documentKey", Values: []any{documentKey}},
			{Method: "orderDesc", Attribute: "$updatedAt"},
		}, queries...)
	}
	result, err := c.do(ctx, http.MethodGet, queryPath(api.create, queries), session, nil)
	if err != nil {
		return nil, err
	}
	items := make([]Annotation, 0)
	for _, row := range rowList(result.Body) {
		item := annotationFromMap(row)
		if item.RowID == "" || item.UserID != userID || item.DocumentKey != documentKey {
			continue
		}
		items = append(items, item)
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].UpdatedAt > items[j].UpdatedAt })
	return items, nil
}

func (c *Client) createAnnotationAt(ctx context.Context, api dataAPI, session string, data map[string]any, permissions []string) (Annotation, error) {
	rowID, err := newRowID()
	if err != nil {
		return Annotation{}, err
	}
	result, err := c.do(ctx, http.MethodPost, api.create, session, map[string]any{
		api.idKey:     rowID,
		"data":        data,
		"permissions": permissions,
	})
	if err != nil {
		return Annotation{}, err
	}
	item := annotationFromPayload(result.Body)
	if item.RowID == "" {
		item = annotationFromMap(data)
		item.RowID = rowID
	}
	return item, nil
}

func (c *Client) getOwnedAnnotation(ctx context.Context, api dataAPI, session, userID, rowID string) (Annotation, error) {
	result, err := c.do(ctx, http.MethodGet, fmtRow(api.get, rowID), session, nil)
	if err != nil {
		return Annotation{}, err
	}
	item := annotationFromPayload(result.Body)
	if item.RowID == "" {
		return Annotation{}, &APIError{Status: http.StatusNotFound, Type: "row_not_found"}
	}
	if item.UserID != userID {
		return Annotation{}, &APIError{Status: http.StatusForbidden, Type: "user_unauthorized"}
	}
	return item, nil
}

func annotationData(userID string, item Annotation) map[string]any {
	return map[string]any{
		"userId":      userID,
		"documentKey": item.DocumentKey,
		"sourcePath":  clip(item.SourcePath, 1024),
		"artifactId":  clip(item.ArtifactID, 160),
		"blockId":     clip(item.BlockID, 160),
		"page":        item.Page,
		"anchorJson":  clip(item.AnchorJSON, 16000),
		"kind":        clip(item.Kind, 24),
		"color":       clip(item.Color, 16),
		"body":        clip(item.Body, 4000),
		"status":      clip(item.Status, 24),
	}
}

func annotationFromPayload(raw []byte) Annotation {
	var payload map[string]any
	if json.Unmarshal(raw, &payload) != nil {
		return Annotation{}
	}
	return annotationFromMap(payload)
}

func annotationFromMap(row map[string]any) Annotation {
	if row == nil {
		return Annotation{}
	}
	data := mapData(row)
	return Annotation{
		RowID:       firstString(row, nil, "$id"),
		UserID:      firstString(row, data, "userId"),
		DocumentKey: firstString(row, data, "documentKey"),
		SourcePath:  firstString(row, data, "sourcePath"),
		ArtifactID:  firstString(row, data, "artifactId"),
		BlockID:     firstString(row, data, "blockId"),
		Page:        firstInt(row, data, "page"),
		AnchorJSON:  firstString(row, data, "anchorJson"),
		Kind:        firstNonEmpty(firstString(row, data, "kind"), "highlight"),
		Color:       firstNonEmpty(firstString(row, data, "color"), "yellow"),
		Body:        firstString(row, data, "body"),
		Status:      firstNonEmpty(firstString(row, data, "status"), "active"),
		CreatedAt:   firstString(row, data, "$createdAt"),
		UpdatedAt:   firstString(row, data, "$updatedAt"),
	}
}

func applyAnnotationPatch(item *Annotation, patch AnnotationPatch) {
	if patch.Body != nil {
		item.Body = clip(*patch.Body, 4000)
	}
	if patch.Color != nil {
		item.Color = clip(*patch.Color, 16)
	}
	if patch.Status != nil {
		item.Status = clip(*patch.Status, 24)
	}
}

func isSkippableAnnotationQuery(err error) bool {
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr == nil {
		return false
	}
	return apiErr.Type == "general_query_invalid" || apiErr.Type == "index_not_found"
}

func validDocumentKey(value string) bool {
	if len(value) != 64 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

// DocumentKey est stable entre artefacts mais change quand le chemin source change.
func DocumentKey(sourcePath string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(sourcePath)))
	return hex.EncodeToString(sum[:])
}

// AnnotationListPath est exposé seulement aux tests de contrat.
func AnnotationListPath(createPath, documentKey string) string {
	queries := []appwriteQuery{
		{Method: "equal", Attribute: "documentKey", Values: []any{documentKey}},
		{Method: "orderDesc", Attribute: "$updatedAt"},
		{Method: "limit", Values: []any{annotationListLimit}},
	}
	return queryPath(createPath, queries)
}
