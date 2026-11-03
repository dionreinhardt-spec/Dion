FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY backend/requirements.lock /app/requirements.lock
RUN pip install --no-cache-dir -r requirements.lock && useradd --create-home --uid 10001 intel
COPY --chown=intel:intel backend/ /app/backend/
COPY --chown=intel:intel config/ /app/config/
RUN mkdir -p /app/backend/data && chown intel:intel /app/backend/data
WORKDIR /app/backend
USER intel
EXPOSE 8000
HEALTHCHECK --interval=20s --timeout=5s --start-period=15s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health/live',timeout=3)"
CMD ["uvicorn", "axiom_intel.api:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-access-log"]
