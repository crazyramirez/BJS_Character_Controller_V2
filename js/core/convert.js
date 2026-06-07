const fs = require('fs');
const path = require('path');
const convert = require('fbx2gltf');
const { NodeIO } = require('@gltf-transform/core');

function qMul([x1, y1, z1, w1], [x2, y2, z2, w2]) {
    return [
        x1 * w2 + w1 * x2 + y1 * z2 - z1 * y2,
        y1 * w2 + w1 * y2 + z1 * x2 - x1 * z2,
        z1 * w2 + w1 * z2 + x1 * y2 - y1 * x2,
        w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
    ];
}

async function fixGLB(glbPath) {
    const io = new NodeIO();
    const doc = await io.read(glbPath);

    // Fix materials
    for (const mat of doc.getRoot().listMaterials()) {
        mat.setMetallicFactor(0);
        mat.setRoughnessFactor(0.5);
    }

    // Flatten RootNode: absorb its transform into each child, then remove it
    for (const scene of doc.getRoot().listScenes()) {
        for (const rootNode of scene.listChildren()) {
            if (rootNode.getName() !== 'RootNode') continue;

            const pScale = rootNode.getScale();       // [100,100,100]
            const pRot = rootNode.getRotation();    // [-0.707,0,0,0.707]

            for (const child of rootNode.listChildren()) {
                const cScale = child.getScale();
                const cRot = child.getRotation();
                const cTrans = child.getTranslation();

                // Combined scale
                child.setScale([cScale[0] * pScale[0], cScale[1] * pScale[1], cScale[2] * pScale[2]]);
                // Combined rotation: parent * child
                child.setRotation(qMul(pRot, cRot));
                // Translate child position into parent space
                child.setTranslation([cTrans[0] * pScale[0], cTrans[1] * pScale[1], cTrans[2] * pScale[2]]);

                scene.addChild(child);
            }

            rootNode.dispose();
        }
    }

    const buf = await io.writeBinary(doc);
    fs.writeFileSync(glbPath, buf);
}

function convertFBXFiles(inputDir, outputDir) {
    fs.readdirSync(inputDir).forEach(file => {
        const filePath = path.join(inputDir, file);
        const stats = fs.statSync(filePath);

        if (stats.isFile() && path.extname(file) === '.fbx') {
            const outputFile = path.join(outputDir, file.replace('.fbx', '.glb'));

            console.log(`Converting file: ${filePath}`);

            convert(filePath, outputFile, []).then(
                async destPath => {
                    await fixGLB(destPath);
                    console.log(`File converted: ${destPath}`);
                },
                error => {
                    console.error(`Error converting file: ${filePath}`);
                    console.error(error);
                }
            );
        } else if (stats.isDirectory()) {
            const newInputDir = path.join(inputDir, file);
            const newOutputDir = path.join(outputDir, file);
            fs.mkdirSync(newOutputDir, { recursive: true });
            convertFBXFiles(newInputDir, newOutputDir);
        }
    });
}

// Convert Files Function
convertFBXFiles('_input', '_output');