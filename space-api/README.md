---
title: ENISE Docs API
emoji: 📚
colorFrom: green
colorTo: yellow
sdk: docker
app_port: 8788
pinned: false
short_description: API Go de ENISE Docs (index, aperçus, compte, assistant)
---

# ENISE Docs API

> Hugging Face réserve désormais les Spaces Docker aux comptes PRO. Sans
> abonnement, déployer l’API sur Cloud Run (`npm run deploy:api:firebase`)
> ou sur Render (`render.yaml`) : voir le README du dépôt.

API Go derrière le site Cloudflare. Le Worker sert les assets et relaie
`/api/*` vers ce Space.

## Endpoints

- `GET /api/health` — état du service
- `GET /api/chat/status` — moteurs de l’assistant disponibles
- `POST /api/chat` — question, réponse en flux `text/event-stream`

## Secrets à définir (Settings → Repository secrets)

| Secret | Rôle |
|---|---|
| `OPENROUTER_API_KEY`, `NVIDIA_API_KEY`, `OPENCODE_API_KEY` | rédaction de l’assistant |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | IA intégrée Cloudflare (Workers AI), moteur essayé en premier |
| `HF_TOKEN` | seulement si le bucket devient privé |
| `CHAT_TRUST_PROXY` | `1` : limite le débit par visiteur derrière le Worker |

Ne jamais placer ces valeurs dans les fichiers du Space : elles seraient
publiques.
