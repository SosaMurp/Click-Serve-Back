from io import BytesIO
from typing import Annotated

import cv2
import face_recognition
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from PIL import Image

app = FastAPI(title="Click & Serve Biometric Service", version="1.0.0")


def decode_image(content: bytes) -> np.ndarray:
    try:
        image = Image.open(BytesIO(content)).convert("RGB")
        return np.asarray(image)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="La imagen no tiene un formato válido.") from exc


def largest_face_encoding(image: np.ndarray) -> np.ndarray:
    # face_recognition encuentra el rostro y genera el embedding de 128 dimensiones.
    locations = face_recognition.face_locations(image, model="hog")
    if not locations:
        raise HTTPException(status_code=422, detail="No se encontró un rostro en la imagen.")
    if len(locations) > 1:
        raise HTTPException(status_code=422, detail="La imagen debe contener un solo rostro.")

    encodings = face_recognition.face_encodings(image, known_face_locations=locations)
    if not encodings:
        raise HTTPException(status_code=422, detail="No se pudo generar el embedding facial.")
    return encodings[0]


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "engine": "opencv-face_recognition"}


@app.post("/compare")
async def compare_faces(
    reference_image: Annotated[UploadFile, File(...)],
    live_image: Annotated[UploadFile, File(...)],
) -> dict[str, float | bool | str]:
    reference = decode_image(await reference_image.read())
    live = decode_image(await live_image.read())

    # OpenCV valida que los buffers sean imágenes decodificables antes del modelo.
    if cv2.imencode(".jpg", reference)[0] is False or cv2.imencode(".jpg", live)[0] is False:
        raise HTTPException(status_code=400, detail="No se pudo decodificar una de las imágenes.")

    reference_encoding = largest_face_encoding(reference)
    live_encoding = largest_face_encoding(live)
    distance = float(face_recognition.face_distance([reference_encoding], live_encoding)[0])
    threshold = 0.48
    confidence = max(0.0, min(1.0, 1.0 - (distance / 1.0)))

    return {
        "match": distance <= threshold,
        "distance": round(distance, 6),
        "confidence": round(confidence, 6),
        "threshold": threshold,
        "engine": "opencv-face_recognition",
    }
