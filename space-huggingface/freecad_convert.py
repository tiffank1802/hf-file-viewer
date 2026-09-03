"""
FreeCAD conversion script for .sldprt to .stl
This script is called by freecadcmd in headless mode
"""
import sys
import os

def convert_sldprt_to_stl(input_path, output_path):
    """
    Convert a SolidWorks .sldprt file to .stl using FreeCAD
    
    Args:
        input_path: Path to the input .sldprt file
        output_path: Path for the output .stl file
    
    Returns:
        tuple: (success: bool, message: str)
    """
    try:
        import FreeCAD
        import Mesh
    except ImportError as e:
        return False, f"Failed to import FreeCAD modules: {e}"
    
    # Set FreeCAD to headless mode
    FreeCAD.ParamGet("User parameter:BaseApp/Preferences/General").SetBool("SkipFirstRun", True)
    
    try:
        # Open the document
        doc = FreeCAD.openDocument(str(input_path))
        
        if doc is None:
            return False, "Failed to open document. The .sldprt format may not be supported or the file is corrupted."
        
        # Get all objects in the document
        objects = doc.Objects
        
        if not objects:
            FreeCAD.closeDocument(doc.Name)
            return False, "No objects found in the document."
        
        # Try to get the mesh from the first object
        # For .sldprt files, there's usually one main object
        obj = objects[0]
        
        # Check if the object has a mesh
        if hasattr(obj, "Mesh") and obj.Mesh is not None:
            mesh = obj.Mesh
        elif hasattr(obj, "Shape"):
            # Convert shape to mesh if no mesh exists
            try:
                mesh = Mesh.Mesh(obj.Shape.tessellate(0.1)[0])
            except Exception as e:
                FreeCAD.closeDocument(doc.Name)
                return False, f"Failed to tessellate shape: {e}"
        else:
            FreeCAD.closeDocument(doc.Name)
            return False, "Object has no mesh or shape data."
        
        # Export the mesh to STL
        Mesh.export([mesh], str(output_path))
        
        # Close the document
        FreeCAD.closeDocument(doc.Name)
        
        # Verify output file was created
        if not os.path.exists(output_path):
            return False, "STL file was not created."
        
        return True, f"Successfully converted to STL: {output_path}"
        
    except Exception as e:
        return False, f"Conversion error: {str(e)}"


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: freecad_convert.py <input.sldprt> <output.stl>")
        sys.exit(1)
    
    input_file = sys.argv[1]
    output_file = sys.argv[2]
    
    success, message = convert_sldprt_to_stl(input_file, output_file)
    print(message)
    sys.exit(0 if success else 1)
