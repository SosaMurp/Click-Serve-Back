# Servicio biometrico OpenCV

Servicio local FastAPI para comparar una imagen de referencia con una captura en vivo.

## Instalacion

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

## Endpoint

`POST /compare` recibe dos partes multipart:

- `reference_image`: rostro de referencia.
- `live_image`: captura actual.

Respuesta:

```json
{
  "match": true,
  "distance": 0.31,
  "confidence": 0.69,
  "threshold": 0.48,
  "engine": "opencv-face_recognition"
}
```

El endpoint exige exactamente un rostro por imagen. El umbral 0.48 es conservador y debe calibrarse con un conjunto de validacion del proyecto.
