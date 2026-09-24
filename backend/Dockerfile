# Image optionnelle de l’API Go.
#
# Le site Cloudflare (Worker + assets) reste le déploiement par défaut.
# Cette image sert si l’API doit tourner sur une machine dédiée, plus proche
# des étudiants, avec un cache mémoire qui reste chaud.
#
#   docker build -f backend/Dockerfile -t enise-docs-api .
#   docker run --rm -p 8788:8788 --env-file .dev.vars \
#     -e ADDR=0.0.0.0:8788 \
#     -e STATIC_DIR=/dist \
#     -v "$PWD/dist:/dist:ro" \
#     enise-docs-api
FROM golang:1.24-bookworm AS build

WORKDIR /src
COPY backend/ /src/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/enise-api ./cmd/enise-api

FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /out/enise-api /usr/local/bin/enise-api
ENV ADDR=0.0.0.0:8788
EXPOSE 8788
ENTRYPOINT ["enise-api"]
