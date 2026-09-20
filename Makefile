.PHONY: up down reset logs db test test-worker test-ai test-etl obs verify-all

up:
	docker compose up --build -d

down:
	docker compose --profile obs --profile etl down

reset:
	docker compose --profile obs --profile etl down -v

logs:
	docker compose logs -f core-api worker ai-service

db:
	docker compose up -d postgres redis

# Observabilidad (Grafana en http://localhost:3001)
obs:
	docker compose --profile obs up -d --build

test: db
	cd services/core-api && npm ci && npm test

test-worker: db
	cd services/bancs-mock && npm ci
	cd services/worker && npm ci && npm test

test-ai:
	docker compose exec ai-service python -m pytest -q

test-etl:
	docker compose run --rm etl python -m pytest -q
