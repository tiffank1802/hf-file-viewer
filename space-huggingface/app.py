"""
Gradio App for converting SolidWorks .sldprt files to .glb format.

Pipeline:
1. Receive .sldprt file upload
2. Convert .sldprt → .stl using FreeCAD (freecadcmd)
3. Convert .stl → .glb using trimesh with proper scaling (mm to meters)
4. Return the .glb file

Note: The .sldprt import module in FreeCAD is experimental.
Test with geometrically simple parts first before validating on complex parts.
"""

import os
import tempfile
import subprocess
import shutil
from pathlib import Path

import gradio as gr
import trimesh
import numpy as np


def convert_sldprt_to_glb(sldprt_file_path):
    """
    Convert a .sldprt file to .glb format.
    
    Args:
        sldprt_file_path: Path to the uploaded .sldprt file
    
    Returns:
        tuple: (success: bool, result_path_or_error_message: str)
    """
    # Create temporary directory for conversion
    temp_dir = tempfile.mkdtemp()
    
    try:
        # Define paths
        input_sldprt = Path(sldprt_file_path)
        output_stl = Path(temp_dir) / "output.stl"
        output_glb = Path(temp_dir) / "output.glb"
        
        # Step 1: Convert .sldprt to .stl using FreeCAD
        freecad_script = Path(__file__).parent / "freecad_convert.py"
        
        if not freecad_script.exists():
            return False, "FreeCAD conversion script not found."
        
        # Run freecadcmd in headless mode
        cmd = [
            "freecadcmd",
            "--console",
            str(freecad_script),
            str(input_sldprt),
            str(output_stl)
        ]
        
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=120  # 2 minute timeout for complex parts
            )
            
            if result.returncode != 0:
                error_msg = result.stderr.strip() or result.stdout.strip()
                return False, f"FreeCAD conversion failed: {error_msg}"
            
            # Verify STL was created
            if not output_stl.exists():
                return False, "STL file was not created by FreeCAD."
                
        except subprocess.TimeoutExpired:
            return False, "FreeCAD conversion timed out. The part may be too complex."
        except FileNotFoundError:
            return False, "freecadcmd not found. FreeCAD may not be properly installed."
        
        # Step 2: Convert .stl to .glb using trimesh
        try:
            # Load the STL mesh
            mesh = trimesh.load(str(output_stl))
            
            # Handle Scene objects (multiple meshes)
            if isinstance(mesh, trimesh.Scene):
                # Apply scaling to all geometries in the scene
                for geom in mesh.geometry.values():
                    # Scale from mm to meters (SolidWorks uses mm, glTF expects meters)
                    geom.apply_scale(0.001)
            else:
                # Single mesh - apply scaling directly
                mesh.apply_scale(0.001)
            
            # Export to GLB
            mesh.export(str(output_glb), file_type='glb')
            
            # Verify GLB was created
            if not output_glb.exists():
                return False, "GLB file was not created."
            
            # Move GLB to a permanent location (Gradio will handle cleanup)
            final_glb_path = Path(tempfile.gettempdir()) / f"{Path(sldprt_file_path).stem}.glb"
            shutil.move(str(output_glb), str(final_glb_path))
            
            return True, str(final_glb_path)
            
        except Exception as e:
            return False, f"STL to GLB conversion failed: {str(e)}"
    
    except Exception as e:
        return False, f"Conversion pipeline error: {str(e)}"
    
    finally:
        # Cleanup temporary directory
        try:
            shutil.rmtree(temp_dir, ignore_errors=True)
        except Exception:
            pass


def process_file(input_file):
    """
    Gradio interface function to process uploaded file.
    
    Args:
        input_file: Path to uploaded .sldprt file
    
    Returns:
        Path to converted .glb file or raises gr.Error
    """
    if input_file is None:
        raise gr.Error("No file uploaded. Please upload a .sldprt file.")
    
    # Validate file extension
    file_ext = Path(input_file).suffix.lower()
    if file_ext != '.sldprt':
        raise gr.Error(f"Invalid file format. Expected .sldprt, got {file_ext}")
    
    # Perform conversion
    success, result = convert_sldprt_to_glb(input_file)
    
    if not success:
        raise gr.Error(result)
    
    return result


# Create Gradio Interface
with gr.Blocks(title="SolidWorks to GLB Converter") as app:
    gr.Markdown("""
    # SolidWorks (.sldprt) to GLB Converter
    
    Upload a SolidWorks part file (.sldprt) to convert it to GLB format for web visualization.
    
    **Important Notes:**
    - The .sldprt import module in FreeCAD is **experimental**
    - Test with geometrically simple parts first
    - Complex surfaces or recent SolidWorks features may not be supported
    - Only geometry (tessellated mesh) is preserved - no parametric history, colors, or materials
    - Conversion may take 30-60 seconds for the first request (cold start)
    """)
    
    with gr.Row():
        with gr.Column():
            input_file = gr.File(
                label="Upload .sldprt file",
                file_types=[".sldprt"],
                type="filepath"
            )
            convert_btn = gr.Button("Convert to GLB", variant="primary")
        
        with gr.Column():
            output_file = gr.File(
                label="Download converted .glb file",
                file_types=[".glb"]
            )
    
    convert_btn.click(
        fn=process_file,
        inputs=input_file,
        outputs=output_file
    )
    
    gr.Markdown("""
    ### How to use this API from your website:
    
    ```python
    from gradio_client import Client
    
    client = Client("your-username/sldprt-to-glb")
    result = client.predict(
        uploaded_file="/path/to/your/file.sldprt",
        api_name="/process_file"
    )
    ```
    
    Or with JavaScript (@gradio/client):
    
    ```javascript
    import { Client } from "@gradio/client";
    
    const client = new Client("your-username/sldprt-to-glb");
    const result = await client.predict("/process_file", {
        uploaded_file: fileInput.files[0]
    });
    ```
    """)


if __name__ == "__main__":
    app.launch(server_name="0.0.0.0", server_port=7860)
