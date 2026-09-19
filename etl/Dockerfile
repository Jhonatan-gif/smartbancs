FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY smartbancs_etl ./smartbancs_etl
COPY tests ./tests
COPY pytest.ini .
# Por defecto: limpia el CSV de muestra y escribe los resultados en /app/data/processed
CMD ["python", "-m", "smartbancs_etl.pipeline", "--input", "data/sample/dirty_transactions.csv", "--out", "data/processed"]
