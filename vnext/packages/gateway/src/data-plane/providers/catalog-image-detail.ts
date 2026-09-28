/** A route may advertise original detail only when it also accepts image input. */
export function supportsOriginalImageDetail(model: {
  chat?: { image_detail_original?: boolean; modalities?: { input?: readonly string[] } }
}): boolean {
  return model.chat?.image_detail_original === true
    && model.chat.modalities?.input?.includes('image') === true
}
