<a href="https://www.viseni.com" target="_blank"><img src="https://www.viseni.com/_demos_/viseni-logo-white.webp" style="width: 200px; margin-bottom: 50px"></a>


# Motor de Animación de Personajes 3D en Babylon.js

Este proyecto es un motor de animación y controlador de personajes en tercera persona desarrollado con **Babylon.js**. Cuenta con un sistema de movimiento basado en físicas de colisión, un árbol de mezcla de locomoción dinámico, efectos de partículas, soporte de combos, lanzamiento de hechizos y soporte completo para dispositivos móviles.

---

## 🎮 Cómo Funciona el Juego Demo

El demo presenta un escenario en tercera persona donde controlas a un personaje tridimensional dentro de un entorno con colisiones activas.

### Características del Engine en el Demo:
*   **Físicas de Movimiento Estables**: El personaje utiliza un colisionador de cápsula con físicas de colisión (`moveWithCollisions`) que le permiten interactuar con el entorno, subir escaleras y deslizarse por rampas de forma suave sin vibraciones verticales.
*   **Locomotion Blend Tree**: El sistema de locomoción calcula en tiempo real la velocidad física de la cápsula y realiza una interpolación lineal de pesos entre tres animaciones principales (`Idle_Loop`, `Walk_Loop` y `Sprint_Loop`) integradas en el grupo virtual `Locomotion`.
*   **Partículas Procedimentales de Polvo**: Se emiten partículas de humo/polvo en los pies del personaje al correr a alta velocidad o al aterrizar tras caídas de altura (impacto).
*   **Soporte Táctil Integrado**: Si se detecta un dispositivo con pantalla táctil, la aplicación activa un joystick analógico digital en pantalla y botones de acción flotantes con retroalimentación háptica.
*   **Post-Procesado Avanzado**: Incluye mapeo de tonos ACES, Bloom difuminado de alto contraste, FXAA y aberración cromática.

### Controles de Teclado y Ratón:
*   `W`, `A`, `S`, `D` / `Flechas`: Mover el personaje relativo a la orientación de la cámara.
*   `Shift (Mayús)`: Correr / Sprint.
*   `Ctrl (Control)`: Agacharse / Crouch.
*   `Espacio`: Saltar (con físicas de gravedad y detección de aterrizaje).
*   `R`: Rodar / Dodge roll (con impulso horizontal).
*   `Q`: Combo de golpes (Jab simple; si se pulsa de nuevo en el tiempo correcto, ejecuta Cross con aviso visual).
*   `E`: Lanzamiento de magia (hechizo simple con entrada, disparo y salida).
*   `F`: Interactuar / Activar palancas.
*   `Arrastrar Ratón`: Rotar cámara orbital alrededor del personaje.

---

## 🛠️ Cómo Implementar el Character Controller en tu Propio Juego

El controlador está diseñado de forma modular en dos clases principales dentro de `js/character-controller.js`:
1.  **`AnimCtrl`**: Gestor de animaciones, transiciones cruzadas (cross-fade) suavizadas por hardware, pesos dinámicos y grupos virtuales.
2.  **`CharCtrl`**: Gestor de físicas, entradas por teclado/táctil, gravedad, partículas y lógica de estado del personaje.

Ambas clases están **totalmente desacopladas de la interfaz de usuario (DOM)**, lo que te permite usarlas en cualquier aplicación de Babylon.js sin requerir un HTML específico.

### Paso 1: Importar los archivos necesarios
Copia los scripts `js/character-controller.js` a tu proyecto y cárgalos en tu HTML o impórtalos en tus módulos JS.

### Paso 2: Integración de Código en tu Escena
A continuación se muestra un ejemplo limpio para instanciar y usar los controladores:

```javascript
// 1. Cargar el modelo GLB de tu personaje (debe contener los huesos y animaciones)
const charRes = await BABYLON.SceneLoader.ImportMeshAsync('', 'assets/', 'tu_personaje.glb', scene);
const charVisualMesh = charRes.meshes[0];

// 2. Configurar sombras y desactivar pickability para evitar obstruir raycasts físicos
charRes.meshes.forEach(m => {
  shadowGenerator.addShadowCaster(m, true);
  m.receiveShadows = true;
  m.isPickable = false;
});

// 3. Crear el colisionador de la cápsula física
const playerCapsule = BABYLON.MeshBuilder.CreateCapsule('playerCapsule', { radius: 0.35, height: 1.8 }, scene);
playerCapsule.position.set(0, 1.3, 0);
playerCapsule.visibility = 0; // Ocultar colisionador
playerCapsule.checkCollisions = true;
playerCapsule.ellipsoid = new BABYLON.Vector3(0.35, 0.96, 0.35);

// 4. Emparentar el mesh visual al colisionador de cápsula
charVisualMesh.setParent(playerCapsule);
charVisualMesh.position.set(0, -0.98, 0); // Offset para que los pies toquen la base
charVisualMesh.rotation.set(0, 0, 0);

// 5. Instanciar AnimCtrl pasándole la lista de animaciones nativas del GLB
const animCtrl = new AnimCtrl(charRes.animationGroups, scene);

// 6. Instanciar CharCtrl con configuraciones personalizadas y callbacks de UI
const charCtrl = new CharCtrl(playerCapsule, charVisualMesh, camera, animCtrl, scene, {
  // Ajustes de constantes físicas
  config: {
    GRAV: 22,            // Gravedad
    JUMP_PWR: 9.5,       // Fuerza de salto
    SPD_WALK: 2.4,       // Velocidad de caminata
    SPD_SPRINT: 6.0,     // Velocidad de carrera
    ACCEL: 14,           // Aceleración lineal
    DECEL: 16,           // Desaceleración
    AIR_CONTROL: true    // Control aéreo (true para control total, false para bloquear dirección y velocidad de despegue)
  },
  // Suscribir eventos a tu propio HUD o UI del juego
  callbacks: {
    onStateChange: (state) => {
      miUI.actualizarEstado(state);
    },
    onSpeedChange: (speed) => {
      miUI.actualizarMarcadorVelocidad(speed);
    },
    onCombo: (textoCombo, estaActivo) => {
      miUI.mostrarCartelCombo(textoCombo, estaActivo);
    }
  }
});

// 7. Actualizar el target de la cámara para que siga al colisionador del jugador
scene.registerBeforeRender(() => {
  const targetPoint = playerCapsule.position.add(new BABYLON.Vector3(0, 0.4, 0));
  camera.target = BABYLON.Vector3.Lerp(camera.target, targetPoint, 0.12);
});
```

---

## 🔄 Fusión y Optimización de Animaciones (`merge_animations.mjs`)

El archivo `merge_animations.mjs` es un script de terminal basado en Node.js que combina las animaciones de un archivo GLB de animaciones (por ejemplo, exportado desde Mixamo) directamente dentro del archivo GLB del personaje. 

Esto genera un **archivo GLB único** (`character_combined.glb`) que almacena tanto el modelo 3D como toda su biblioteca de animaciones, optimizado para ser cargado de un solo golpe de red.

### Características de `merge_animations.mjs`:
*   **Corrección Cuaterniónica Automática**: Retargetea las rotaciones de los huesos mediante un cambio de base matemático en el espacio de mundo. Esto corrige la discrepancia de orientación de ejes entre la armadura de animación (Mixamo/Unity) y el modelo del personaje final.
*   **Evita Deformación de Extremidades**: Descarta canales de escala (`IGNORE_SCALE`) en todos los huesos y las traslaciones en huesos no raíz (`IGNORE_NON_ROOT_TRANSLATION`), evitando que las extremidades se estiren o encojan de forma anormal al usar animaciones de personajes con proporciones distintas.
*   **Compresión Draco**: Integra compresión geométrica Draco y remuestreo de curvas de animación (`resample`), lo que reduce radicalmente el tamaño del archivo GLB de salida en más de un 70%.
*   **Generador de Manifiesto**: Crea de manera automática un archivo de texto plano contiguo (`character_combined_animations.txt`) con los nombres limpios de todas las animaciones disponibles, facilitando el desarrollo.

### Requisitos Previos:
Debes tener instalado Node.js y las dependencias de optimización gráfica.
```bash
npm install fs-extra @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions draco3dgltf
```

### Cómo ejecutar el Script:
Crea un directorio de entrada `_input/` y coloca el modelo 3D del personaje (`character.glb`) y el archivo consolidado de animaciones (`animations.glb`). Luego ejecuta:

```bash
node merge_animations.mjs -c _input/character.glb -a _input/animations.glb -o assets/character_combined.glb
```

#### Parámetros del CLI:
*   `-c`, `--character`: Ruta al archivo GLB del personaje base (con esqueleto).
*   `-a`, `--animations`: Ruta al archivo GLB que contiene las pistas de animación.
*   `-o`, `--output`: Ruta de salida para el archivo GLB único combinado.

#### Micro-ajustes de Postura rápidos:
Si los brazos del personaje quedan demasiado pegados al cuerpo o las piernas cruzadas debido a diferencias en el rigging de Mixamo, puedes editar las siguientes constantes al inicio de `merge_animations.mjs` antes de correr el comando:
*   `ARM_SPREAD_ANGLE = -5`: Ajusta en grados la separación de los brazos del cuerpo.
*   `LEG_SPREAD_ANGLE = 5`: Abre o cierra la separación de las piernas hacia los lados.
