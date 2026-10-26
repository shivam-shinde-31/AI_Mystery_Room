export interface ImageProvider {
  render(description: string, altDescription: string): Promise<{ svg: string; altDescription: string }>;
}

export class SvgImageProvider implements ImageProvider {
  async render(description: string, altDescription: string) {
    const label = description.replace(/[<>]/g, '').slice(0, 72);
    const safeLabel = label.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    return {
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 300"><rect width="480" height="300" fill="#222428"/><rect x="24" y="24" width="432" height="252" fill="#d9d0bf"/><text x="48" y="155" font-size="16" fill="#333">${safeLabel}</text></svg>`,
      altDescription
    };
  }
}
