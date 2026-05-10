FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV VIRTUAL_ENV="/opt/voxcpm-venv"
ENV PATH="/root/.local/bin:/opt/voxcpm-venv/bin:${PATH}"
ENV VOXCPM_MODEL="openbmb/VoxCPM2"
ENV VOXCPM_DEVICE="cuda"
ENV VOXCPM_OPTIMIZE="true"
ENV VOXCPM_LOAD_DENOISER="false"

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg git \
  && rm -rf /var/lib/apt/lists/*

RUN curl -LsSf https://astral.sh/uv/install.sh | sh

WORKDIR /app
COPY services/voxcpm/requirements.txt /app/services/voxcpm/requirements.txt

RUN uv python install 3.11 \
  && uv venv /opt/voxcpm-venv --python 3.11 \
  && uv pip install --python /opt/voxcpm-venv/bin/python torch torchaudio --index-url https://download.pytorch.org/whl/cu124 \
  && uv pip install --python /opt/voxcpm-venv/bin/python -r /app/services/voxcpm/requirements.txt

COPY services/voxcpm/server.py /app/services/voxcpm/server.py

EXPOSE 8809

CMD ["uvicorn", "services.voxcpm.server:app", "--host", "0.0.0.0", "--port", "8809"]
