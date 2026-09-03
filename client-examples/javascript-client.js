/**
 * Client example for calling the SolidWorks to GLB Converter Space
 * 
 * This Node.js/JavaScript example shows how to call the Hugging Face Space
 * from your backend server. Never expose HF_TOKEN to the client side.
 * 
 * Install dependencies:
 *   npm install @gradio/client
 */

import { Client } from "@gradio/client";

/**
 * Convert a SolidWorks .sldprt file to GLB using the Hugging Face Space
 * 
 * @param {string} sldprtFilePath - Path to the .sldprt file on your server
 * @param {string} hfSpaceName - Hugging Face Space name (e.g., "username/sldprt-to-glb")
 * @param {string} [hfToken] - Optional HF token for private spaces
 * @returns {Promise<string>} - Path/URL to the converted .glb file
 */
async function convertSldprtToGlb(sldprtFilePath, hfSpaceName, hfToken = null) {
    // Create client with optional token for private spaces
    const options = hfToken ? { hf_token: hfToken } : {};
    const client = new Client(hfSpaceName, options);
    
    try {
        console.log(`Converting ${sldprtFilePath} to GLB...`);
        
        // Call the Space API
        const result = await client.predict("/process_file", {
            uploaded_file: sldprtFilePath
        });
        
        console.log("Conversion successful!");
        console.log("GLB file:", result.data);
        
        return result.data;
        
    } catch (error) {
        console.error("Conversion failed:", error.message);
        
        // Handle common errors
        if (error.message.includes("timeout")) {
            throw new Error("Conversion timed out. The part may be too complex.");
        }
        if (error.message.includes("429")) {
            throw new Error("Rate limit exceeded. Please wait before trying again.");
        }
        if (error.message.includes("Cold start")) {
            throw new Error("Space is starting up. This may take 30-60 seconds on first request.");
        }
        
        throw error;
    }
}

/**
 * Express.js endpoint example
 * 
 * Usage in your Express app:
 *   app.post('/api/convert-sldprt', upload.single('file'), convertEndpoint);
 */
async function convertEndpoint(req, res) {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "No file uploaded" });
        }
        
        const filePath = req.file.path;
        const HF_SPACE_NAME = "your-username/sldprt-to-glb";
        const HF_TOKEN = process.env.HF_TOKEN; // Store in environment variable
        
        console.log(`Processing file: ${filePath}`);
        
        // Show loading state to client
        res.json({ 
            status: "processing", 
            message: "Converting file. First request may take 30-60 seconds (cold start)." 
        });
        
        // Perform conversion (in production, use a job queue instead)
        const glbPath = await convertSldprtToGlb(filePath, HF_SPACE_NAME, HF_TOKEN);
        
        // Return the GLB URL/path to the client
        res.json({
            status: "success",
            glbUrl: glbPath,
            message: "File converted successfully"
        });
        
    } catch (error) {
        console.error("Conversion error:", error);
        res.status(500).json({
            status: "error",
            message: error.message || "Conversion failed"
        });
    }
}

// Example usage
if (import.meta.url === `file://${process.argv[1]}`) {
    // Running directly
    const HF_SPACE_NAME = "your-username/sldprt-to-glb";
    const HF_TOKEN = process.env.HF_TOKEN;
    
    async function main() {
        try {
            const glbPath = await convertSldprtToGlb(
                "./example-part.sldprt",
                HF_SPACE_NAME,
                HF_TOKEN
            );
            console.log(`Converted file available at: ${glbPath}`);
        } catch (error) {
            console.error("Error:", error.message);
        }
    }
    
    main();
}

export { convertSldprtToGlb, convertEndpoint };
