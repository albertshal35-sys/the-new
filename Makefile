.PHONY: up down logs test test-worker test-web backfill stats worker api web reprocess

up:            ## build and start db, migrate, worker, api, app
	docker compose up -d --build
down:
	docker compose down
logs:
	docker compose logs -f worker
backfill:      ## run pending 365-day backfills (also done automatically by the worker on first start)
	docker compose run --rm worker icecap backfill
stats:
	docker compose run --rm worker icecap stats
reprocess:     ## re-apply eligibility/normalization rules to stored raw records (never alerts)
	docker compose run --rm worker icecap reprocess

# ---- local (no Docker) ----
test: test-worker test-web
test-worker:
	cd worker && python -m pytest -q
test-web:
	cd web && npm test && npx tsc --noEmit
worker:
	cd worker && python -m icecap.cli worker
api:
	cd worker && python -m icecap.cli api
web:
	cd web && npm run dev
