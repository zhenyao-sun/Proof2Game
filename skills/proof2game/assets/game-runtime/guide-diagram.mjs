const colors = {ink:'#233d31', green:'#467d5d', blue:'#366f9a', orange:'#a85425', gray:'#65736c'};
const number = {type:'number'};
const string = {type:'string'};
const color = {type:'string', enum:Object.keys(colors)};
const point = {type:'array', items:number};
const list = items => ({type:'array', items});
const object = properties => ({type:'object', properties, required:Object.keys(properties), additionalProperties:false});
const shape = (name, properties) => object({kind:{type:'string', enum:[name]}, color, ...properties});
const shapes = {
  line: shape('line', {x1:number, y1:number, x2:number, y2:number, arrow:{type:'boolean'}}),
  curve: shape('curve', {points:list(point)}),
  circle: shape('circle', {x:number, y:number, radius:number}),
  rectangle: shape('rectangle', {x:number, y:number, width:number, height:number}),
  label: shape('label', {x:number, y:number, text:string}),
};
export const diagramSchema = {anyOf:[
  {type:'null'}, object({alt:string, elements:list({anyOf:Object.values(shapes)})}),
]};

const width = 640, height = 400;
const start = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#fff"/>`;
const end = '</svg>';
const escapeText = value => value.replace(/[&<>]/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;'}[char]));
const coordinates = (value, max) => Number.isFinite(value) && value >= 0 && value <= max;
const validText = (value, max) => typeof value === 'string' && value.trim().length > 0 &&
  value.length <= max && !/[\u0000-\u001f\ufffe\uffff]/u.test(value) && value.isWellFormed();
function invalid(){throw new Error('Invalid Guide diagram.');}

function draw(element){
  if(!element || !Object.hasOwn(shapes, element.kind) || !Object.hasOwn(colors, element.color)) invalid();
  const ink = colors[element.color];
  const stroke = `fill="none" stroke="${ink}" stroke-width="2.5"`;
  const xy = (x,y) => coordinates(x,width) && coordinates(y,height);
  switch(element.kind){
    case 'line': {
      const {x1,y1,x2,y2,arrow} = element;
      if(!xy(x1,y1) || !xy(x2,y2) || typeof arrow !== 'boolean') invalid();
      const line = `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${stroke}/>`;
      if(!arrow || (x1===x2 && y1===y2)) return line;
      const angle = Math.atan2(y2-y1,x2-x1);
      const tip = offset => `${(x2-11*Math.cos(angle+offset)).toFixed(2)},${(y2-11*Math.sin(angle+offset)).toFixed(2)}`;
      return line+`<polyline points="${tip(-0.5)} ${x2},${y2} ${tip(0.5)}" ${stroke}/>`;
    }
    case 'curve': {
      const {points} = element;
      if(!Array.isArray(points) || points.length<2 || points.length>80 ||
        points.some(pair=>!Array.isArray(pair) || pair.length!==2 || !xy(...pair))) invalid();
      return `<polyline points="${points.map(pair=>pair.join(',')).join(' ')}" ${stroke}/>`;
    }
    case 'circle': {
      const {x,y,radius} = element;
      if(!xy(x,y) || !coordinates(radius,height) || radius===0) invalid();
      return `<circle cx="${x}" cy="${y}" r="${radius}" ${stroke}/>`;
    }
    case 'rectangle': {
      const {x,y,width:boxWidth,height:boxHeight} = element;
      if(!xy(x,y) || !xy(boxWidth,boxHeight) || boxWidth===0 || boxHeight===0) invalid();
      return `<rect x="${x}" y="${y}" width="${boxWidth}" height="${boxHeight}" ${stroke}/>`;
    }
    case 'label': {
      const {x,y,text} = element;
      if(!xy(x,y) || !validText(text,100)) invalid();
      return `<text x="${x}" y="${y}" fill="${ink}" font-size="19" font-family="sans-serif" text-anchor="middle">${escapeText(text)}</text>`;
    }
  }
}

export function renderGuideDiagram(diagram){
  if(!diagram || !validText(diagram.alt,500) || !Array.isArray(diagram.elements) ||
    !diagram.elements.length || diagram.elements.length>40) invalid();
  const image = {alt:diagram.alt, svg:start+diagram.elements.map(draw).join('')+end};
  if(!validGuideImage(image)) invalid();
  return image;
}

// Accept only the static image grammar the renderer writes. Imported saves carry
// the original SVG bytes, so reading them never depends on rerendering old steps.
const n = '-?(?:\\d+(?:\\.\\d+)?)(?:e[+-]\\d+)?';
const attrs = names => names.split(' ').map(name=>`${name}="${n}"`).join(' ');
const ink = `(?:${Object.values(colors).join('|')})`;
const stroke = `fill="none" stroke="${ink}" stroke-width="2\\.5"`;
const elementPattern = new RegExp([
  `<line ${attrs('x1 y1 x2 y2')} ${stroke}/>`,
  `<polyline points="${n},${n}(?: ${n},${n}){1,79}" ${stroke}/>`,
  `<circle ${attrs('cx cy r')} ${stroke}/>`,
  `<rect ${attrs('x y width height')} ${stroke}/>`,
  `<text ${attrs('x y')} fill="${ink}" font-size="19" font-family="sans-serif" text-anchor="middle">(?:[^<&>\\x00-\\x1f]|&amp;|&lt;|&gt;){1,100}</text>`,
].join('|'), 'uy');

export function validGuideImage(image){
  if(!image || typeof image!=='object' || Object.keys(image).length!==2 || !validText(image.alt,500) ||
    typeof image.svg!=='string' || !image.svg.isWellFormed() || new TextEncoder().encode(image.svg).byteLength>24*1024 ||
    !image.svg.startsWith(start) || !image.svg.endsWith(end)) return false;
  elementPattern.lastIndex = start.length;
  const stop = image.svg.length-end.length;
  let count = 0;
  while(elementPattern.lastIndex<stop){
    if(++count>80 || !elementPattern.test(image.svg)) return false;
  }
  return count>0 && elementPattern.lastIndex===stop;
}

export function validSavedIllustrations(message){
  if(message.image_retry!==undefined && (message.role!=='assistant'||message.image_retry!==true))return false;
  if(message.images===undefined)return true;
  if(message.role!=='assistant'||!Array.isArray(message.images)||message.images.length>3)return false;
  const paragraphs=Math.max(1,message.content.trim().split(/\n\s*\n/).length);
  return message.images.every(image=>image && Object.keys(image).length===3 &&
    validText(image.alt,500) && Number.isSafeInteger(image.after_paragraph) &&
    image.after_paragraph>=0 && image.after_paragraph<paragraphs &&
    typeof image.data_url==='string' && image.data_url.length<=11200000 &&
    /^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]+=*$/.test(image.data_url) &&
    (image.data_url.length-'data:image/png;base64,'.length)%4===0);
}
