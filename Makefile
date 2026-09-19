.PHONY: up down reset logs db test

up:
$\tdocker compose up --build -d

down:
$\tdocker compose down

reset:
$\tdocker compose down -v

logs:
$\tdocker compose logs -f core-api

db:
$\tdocker compose up -d postgres

test: db
$\tcd services/core-api && npm ci && npm test
