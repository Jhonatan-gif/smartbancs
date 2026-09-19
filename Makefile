.PHONY: up down reset logs db test test-worker

up:
$\tdocker compose up --build -d

down:
$\tdocker compose down

reset:
$\tdocker compose down -v

logs:
$\tdocker compose logs -f core-api worker

db:
$\tdocker compose up -d postgres redis

test: db
$\tcd services/core-api && npm ci && npm test

test-worker: db
$\tcd services/bancs-mock && npm ci
$\tcd services/worker && npm ci && npm test
