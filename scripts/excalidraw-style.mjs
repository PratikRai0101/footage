// User preference: Excalidraw's default handwritten font and middle Sloppiness setting.
export const drawingDefaults = Object.freeze({ fontFamily: 5, roughness: 1 });

export function applyDrawingStyle(drawing) {
  return {
    ...drawing,
    appState: {
      ...drawing.appState,
      currentItemFontFamily: drawingDefaults.fontFamily,
      currentItemRoughness: drawingDefaults.roughness,
    },
    elements: drawing.elements.map(element => ({
      ...element,
      roughness: drawingDefaults.roughness,
      ...(element.type === 'text' ? { fontFamily: drawingDefaults.fontFamily } : {}),
    })),
  };
}
