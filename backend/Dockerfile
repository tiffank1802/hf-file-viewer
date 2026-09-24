# Image de l’API Go d’ENISE Docs pour Cloud Run (projet Firebase).
#
# Construite par Cloud Build : npm run deploy:api:firebase
# Cloud Run fournit PORT (8080) : le serveur écoute 0.0.0.0:$PORT.
# Ne pas définir ADDR ici, il prendrait le pas sur PORT.
FROM golang:1.24-bookworm AS build

WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/enise-api ./cmd/enise-api

FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=build /out/enise-api /enise-api
# Disque éphémère de Cloud Run : le cache repart à vide à chaque instance.
ENV CACHE_DIR=/tmp/enise-docs-cache
EXPOSE 8080
ENTRYPOINT ["/enise-api"]
