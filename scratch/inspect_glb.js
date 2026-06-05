const { NodeIO } = require('@gltf-transform/core');
const path = require('path');

async function main() {
  const io = new NodeIO();
  const doc = await io.read(path.join(__dirname, '..', 'assets', 'counter-map.glb'));
  const root = doc.getRoot();
  
  let minY = Infinity;
  let maxY = -Infinity;
  
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const positionAccessor = primitive.getAttribute('POSITION');
      if (positionAccessor) {
        const min = positionAccessor.getMin();
        const max = positionAccessor.getMax();
        if (min && min[1] < minY) minY = min[1];
        if (max && max[1] > maxY) maxY = max[1];
      }
    }
  }
  
  console.log(`GLB Bounding Box Y range: [${minY}, ${maxY}]`);
}

main().catch(console.error);
