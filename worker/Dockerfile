FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY worker/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY worker/pyproject.toml /app/pyproject.toml
COPY worker/icecap /app/icecap
COPY worker/tests /app/tests
COPY db/migrations /app/migrations
RUN pip install --no-cache-dir -e . && useradd -m icecap && mkdir -p /app/var && chown -R icecap /app/var
USER icecap
CMD ["icecap", "worker"]
