# Space Hugging Face de l’API Go ENISE Docs.
# Le Space reçoit les sources du dossier backend/ à plat :
# go.mod, cmd/enise-api/main.go et internal/...
#
# Déploiement : HF_TOKEN=... npm run deploy:api
FROM golang:1.24-bookworm AS build

WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/enise-api ./cmd/enise-api

FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /out/enise-api /usr/local/bin/enise-api

# Le Worker Cloudflare appelle l’API sur ce port (app_port du Space).
ENV ADDR=0.0.0.0:8788
EXPOSE 8788
ENTRYPOINT ["enise-api"]
