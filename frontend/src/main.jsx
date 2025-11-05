import React from 'react'
import { createRoot } from 'react-dom/client'
import SingleFileComponent from './SingleFileComponent'

function App() {
    return (
        <div>
            <SingleFileComponent />
        </div>
    )
}

createRoot(document.getElementById('root')).render(<App />)
