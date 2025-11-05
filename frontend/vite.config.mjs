import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// ESM Vite config: relative asset paths and build output to ../build
export default defineConfig({
    base: './',
    plugins: [react()],
    build: {
        outDir: '../build',
        emptyOutDir: true
    }
})
