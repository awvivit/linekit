declare module 'imagetracerjs' {
  export type ImageTracerImage = {
    width: number
    height: number
    data: Uint8ClampedArray
  }

  export type ImageTracerOptions = {
    ltres?: number
    qtres?: number
    pathomit?: number
    rightangleenhance?: boolean
    colorsampling?: number
    numberofcolors?: number
    mincolorratio?: number
    colorquantcycles?: number
    layering?: number
    strokewidth?: number
    linefilter?: boolean
    scale?: number
    roundcoords?: number
    viewbox?: boolean
    desc?: boolean
    blurradius?: number
    blurdelta?: number
    lcpr?: number
    qcpr?: number
  }

  export type ImageTracer = {
    imagedataToSVG(image: ImageTracerImage, options?: ImageTracerOptions): string
  }

  const imageTracer: ImageTracer
  export default imageTracer
}
