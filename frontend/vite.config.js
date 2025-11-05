import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Combined Vite config: produce relative asset URLs (base: './') and write
// built files into the repo-level `build/` folder so Express can serve them.
export default defineConfig({
    base: './',
    plugins: [react()],
    build: {
        outDir: '../build',
        emptyOutDir: true
    }
})
