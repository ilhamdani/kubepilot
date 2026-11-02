/// <reference types="vite/client" />

declare module '*.css';
declare module '*?worker' {
  const workerConstructor: new () => Worker;
  export default workerConstructor;
}
