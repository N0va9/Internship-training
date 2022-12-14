/**
 * Container class to manage connecting to the WebXR Device API
 * and handle rendering on every frame.
 */
class App {
  constructor() {
    this.onXRFrame = this.onXRFrame.bind(this);
    this.onEnterAR = this.onEnterAR.bind(this);

    this.init();
  }

  /**
   * Fetches the XRDevice, if available.
   */
  async init() {
    // The entry point of the WebXR Device API is on `navigator.xr`.
    // We also want to ensure that `XRSession` has `requestHitTestSource`,
    // indicating that the #webxr-hit-test flag is enabled.
    if (navigator.xr && XRSession.prototype.requestHitTestSource) {
      console.log(
        "navigator.xr && XRSession.prototype.requestHitTestSource ok"
      );
      navigator.xr.isSessionSupported("immersive-ar").then(
        () => {
          console.log("supportsSession immersive-ar ok");
        },
        () => {
          this.onNoXRDevice();
        }
      );
    } else {
      // If `navigator.xr` or `XRSession.prototype.requestHitTest`
      // does not exist, we must display a message indicating there
      // are no valid devices.
      this.onNoXRDevice();
      return;
    }

    // We found an XRDevice! Bind a click listener on our "Enter AR" button
    // since the spec requires calling `device.requestSession()` within a
    // user gesture.
    document
      .querySelector("#enter-ar")
      .addEventListener("click", this.onEnterAR);
  }

  /**
   * Toggle on a class on the page to disable the "Enter AR"
   * button and display the unsupported browser message.
   */
  onNoXRDevice() {
    document.body.classList.add("unsupported");
  }

  /**
   * Handle a click event on the '#enter-ar' button and attempt to
   * start an XRSession.
   */
  async onEnterAR() {
    // Now that we have an XRDevice, and are responding to a user
    // gesture, we must create an XRPresentationContext on a
    // canvas element.
    const outputCanvas = document.createElement("canvas");

    // requestSession with { optionalFeatures: ['dom-overlay-for-handheld-ar'] }, breaks XRInputs

    // Request a session
    navigator.xr
      .requestSession("immersive-ar")
      .then((xrSession) => {
        this.session = xrSession;
        console.log("requestSession immersive-ar ok");
        xrSession.addEventListener("end", this.onXRSessionEnded.bind(this));
        // If `requestSession` is successful, add the canvas to the
        // DOM since we know it will now be used.
        document.body.appendChild(outputCanvas);
        // Do necessary session setup here.
        this.onSessionStarted();
      })
      .catch((error) => {
        // "immersive-ar" sessions are not supported
        console.warn("requestSession immersive-ar error: ", error);
        this.onNoXRDevice();
      });
  }

  onXRSessionEnded() {
    console.log("onXRSessionEnded");
    document.body.classList.remove("ar");
    document.body.classList.remove("stabilized");
    if (this.renderer) {
      this.renderer.vr.setSession(null);
      this.stabilized = false;
    }
  }

  /**
   * Called when the XRSession has begun. Here we set up our three.js
   * renderer, scene, and camera and attach our XRWebGLLayer to the
   * XRSession and kick off the render loop.
   */
  async onSessionStarted() {
    // Add the `ar` class to our body, which will hide our 2D components
    document.body.classList.add("ar");

    // To help with working with 3D on the web, we'll use three.js. Set up
    // the WebGLRenderer, which handles rendering to our session's base layer.
    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.autoClear = false;

    this.gl = this.renderer.getContext();

    // this.renderer.vr === new WebXRManager(...) -> https://github.com/mrdoob/three.js/blob/dev/src/renderers/webvr/WebXRManager.js
    this.renderer.vr.enabled = true;

    this.XRReferenceSpaceType = "local";

    this.renderer.vr.setReferenceSpaceType(this.XRReferenceSpaceType);
    this.renderer.vr.setSession(this.session);

    // Set our session's baseLayer to an XRWebGLLayer
    // using our new renderer's context
    this.session.baseLayer = new XRWebGLLayer(this.session, this.gl);

    // A THREE.Scene contains the scene graph for all objects in the
    // render scene.
    this.scene = new THREE.Scene();

    const geometry = new THREE.BoxBufferGeometry(0.5, 0.5, 0.5);
    const material = new THREE.MeshNormalMaterial();

    // Translate the cube up 0.25m so that the origin of the cube
    // is on its bottom face
    geometry.applyMatrix(new THREE.Matrix4().makeTranslation(0, 0.25, 0));

    this.model = new THREE.Mesh(geometry, material);

    // We'll update the camera matrices directly from API, so
    // disable matrix auto updates so three.js doesn't attempt
    // to handle the matrices independently.
    this.camera = new THREE.PerspectiveCamera();
    this.camera.matrixAutoUpdate = false;

    // Add a Reticle object, which will help us find surfaces by drawing
    // a ring shape onto found surfaces. See source code
    // of Reticle in shared/utils.js for more details.

    this.reticle = new Reticle(this.camera);
    this.scene.add(this.reticle);

    // Also done by three.js WebXRManager setSession
    this.frameOfRef = await this.session.requestReferenceSpace("local");

    this.tick();
  }

  tick() {
    this.rafId = this.session.requestAnimationFrame(this.onXRFrame);
  }

  /**
   * Called on the XRSession's requestAnimationFrame.
   * Called with the time and XRPresentationFrame.
   */
  onXRFrame(time, frame) {
    const { session } = frame;

    const pose =
      "getDevicePose" in frame
        ? frame.getDevicePose(this.frameOfRef)
        : frame.getViewerPose(this.frameOfRef);

    // Queue up the next frame
    this.tick();

    if (pose == null) {
      return;
    }

    for (const view of frame.getViewerPose(this.frameOfRef).views) {
      const viewport = session.renderState.baseLayer.getViewport(view);
      this.renderer.setViewport(
        viewport.x,
        viewport.y,
        viewport.width,
        viewport.height
      );
      this.camera.projectionMatrix.fromArray(view.projectionMatrix);
      const viewMatrix = new THREE.Matrix4().fromArray(
        view.transform.inverse.matrix
      );

      this.camera.matrix.getInverse(viewMatrix);
      this.camera.updateMatrixWorld(true);

      // NOTE: Updating input or the reticle is dependent on the camera's
      // pose, hence updating these elements after camera update but
      // before render.
      this.reticle.update(this.session, this.frameOfRef);
      this.processXRInput(frame);

      // NOTE: Clearing depth caused issues on Samsung devices
      // @see https://github.com/googlecodelabs/ar-with-webxr/issues/8
      // this.renderer.clearDepth();
      this.renderer.render(this.scene, this.camera);
    }

    // If the reticle has found a hit (is visible) and we have
    // not yet marked our app as stabilized, do so
    if (this.reticle.visible && !this.stabilized) {
      this.stabilized = true;
      document.body.classList.add("stabilized");
    }
  }

  processXRInput(frame) {
    const { session } = frame;

    const sources = Array.from(session.inputSources).filter(
      (input) => input.targetRayMode === "screen"
    );

    if (sources.length === 0) {
      return;
    }

    const pose = frame.getPose(sources[0].targetRaySpace, this.frameOfRef);
    if (pose) {
      this.placeModel();
    }
  }

  async placeModel() {
    // The requestHitTest function takes an x and y coordinate in
    // Normalized Device Coordinates, where the upper left is (-1, 1)
    // and the bottom right is (1, -1). This makes (0, 0) our center.
    const x = 0;
    const y = 0;

    if (this.session == null) {
      return;
    }
    this.raycaster = this.raycaster || new THREE.Raycaster();
    this.raycaster.setFromCamera(
      {
        x,
        y,
      },
      this.camera
    );
    const ray = this.raycaster.ray;
    let xrray = new XRRay(ray.origin, ray.direction);

    let hits;
    try {
      hits = await this.session.requestHitTest(xrray, this.frameOfRef);
    } catch (e) {
      // Spec says this should no longer throw on invalid requests:
      // https://github.com/immersive-web/hit-test/issues/24
      // But in practice, it will still happen, so just ignore:
      // https://github.com/immersive-web/hit-test/issues/37
      console.log(e);
    }

    if (hits && hits.length) {
      const presentedScene = this.scene;
      // We can have multiple collisions per hit test. Let's just take the
      // first hit, the nearest, for now.
      const hit = hits[0];

      // Our XRHitResult object has one property, `hitMatrix`, a
      // Float32Array(16) representing a 4x4 Matrix encoding position where
      // the ray hit an object, and the orientation has a Y-axis that corresponds
      // with the normal of the object at that location.
      // Turn this matrix into a THREE.Matrix4().
      const hitMatrix = new THREE.Matrix4().fromArray(hit.hitMatrix);

      // Now apply the position from the hitMatrix onto our model.
      this.model.position.setFromMatrixPosition(hitMatrix);

      // Ensure our model has been added to the scene.
      this.scene.add(this.model);

      // Orient the dolly/model to face the camera
      const camPosition = new THREE.Vector3().setFromMatrixPosition(
        this.camera.matrix
      );
      this.model.lookAt(camPosition.x, this.model.position.y, camPosition.z);
      if (presentedScene.pivot) {
        this.model.rotateY(-presentedScene.pivot.rotation.y);
      }
    }
  }
}

window.app = new App();
