import sanitizeHtml from 'sanitize-html';

const SVG_TAGS = ['svg','g','defs','linearGradient','radialGradient','stop','rect','circle','ellipse','line','polyline','polygon','path','text','tspan','title','desc','filter','feGaussianBlur','feColorMatrix','feTurbulence','pattern','clipPath','mask'];
const SVG_ATTRS = ['viewBox','width','height','x','y','x1','x2','y1','y2','cx','cy','r','rx','ry','d','points','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','opacity','transform','font-size','font-family','font-weight','text-anchor','offset','stop-color','stop-opacity','gradientUnits','gradientTransform','id','class','filter','clip-path','mask','xmlns'];
export function sanitizeSvg(svg: string) {
  const clean = sanitizeHtml(svg, { allowedTags: SVG_TAGS, allowedAttributes: { '*': SVG_ATTRS }, allowedSchemes: [], disallowedTagsMode: 'discard' });
  return clean.replace(/\s(?:on[a-z]+|style)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '').replace(/(?:href|xlink:href)\s*=\s*("[^"]*"|'[^']*')/gi, '').slice(0, 8192);
}
export function sanitizeDocument(html: string) {
  return sanitizeHtml(html, { allowedTags: ['p','br','strong','em','b','i','ul','ol','li','table','thead','tbody','tr','th','td','h1','h2','h3','blockquote','span','div'], allowedAttributes: { '*': ['class'] } });
}
