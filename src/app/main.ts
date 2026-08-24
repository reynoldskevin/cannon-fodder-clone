import * as THREE from 'three'
import { CORE_VERSION } from '../core/version'

const mount = document.querySelector<HTMLDivElement>('#app')
if (!mount) throw new Error('missing #app mount point')

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setSize(window.innerWidth, window.innerHeight)
mount.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x101418)

const aspect = window.innerWidth / window.innerHeight
const frustum = 8
const camera = new THREE.OrthographicCamera(
  (-frustum * aspect) / 2,
  (frustum * aspect) / 2,
  frustum / 2,
  -frustum / 2,
  0.1,
  100,
)
camera.position.set(10, 10, 10)
camera.lookAt(0, 0, 0)

scene.add(new THREE.AmbientLight(0xffffff, 0.6))
const sun = new THREE.DirectionalLight(0xffffff, 1.2)
sun.position.set(5, 10, 7)
scene.add(sun)

const cube = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0x6f9f4f }),
)
scene.add(cube)

window.addEventListener('resize', () => {
  const a = window.innerWidth / window.innerHeight
  camera.left = (-frustum * a) / 2
  camera.right = (frustum * a) / 2
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
})

renderer.setAnimationLoop((time) => {
  cube.rotation.y = time / 2000
  renderer.render(scene, camera)
})

console.info(`game-week scaffold up (core ${CORE_VERSION})`)
