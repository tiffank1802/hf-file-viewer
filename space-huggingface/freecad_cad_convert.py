"""
FreeCAD batch conversion script: CAD (.step/.stp/.iges/.igs/.sldprt) to .stl.

Called headless by app.py:
    freecadcmd --console freecad_cad_convert.py <input> <output.stl> <tolerance_mm>

The file is imported with the ``Import`` module (``FreeCAD.openDocument``
only reads native .FCStd files), every solid found in the document is
tessellated with the requested linear deflection (mm) and all meshes are
merged into a single STL by Mesh.export.
"""

import os
import sys


def convert_cad_to_stl(input_path, output_path, tolerance):
    """Convert a CAD file to STL, return (success: bool, message: str)."""
    try:
        import FreeCAD
        import Import
        import Mesh
    except ImportError as exc:
        return False, f"Failed to import FreeCAD modules: {exc}"

    FreeCAD.ParamGet("User parameter:BaseApp/Preferences/General").SetBool("SkipFirstRun", True)

    try:
        doc = FreeCAD.newDocument("CadImport")
    except Exception as exc:
        return False, f"Failed to create document ({exc})."

    try:
        try:
            Import.insert(str(input_path), doc.Name)
        except Exception as exc:
            return False, (
                f"Failed to import '{os.path.basename(str(input_path))}' ({exc})."
            )
        try:
            doc.recompute()
        except Exception:
            pass

        objects = list(doc.Objects or [])
        if not objects:
            return False, "Import produced no objects (unsupported or empty file)."

        meshes = []
        for obj in objects:
            try:
                if hasattr(obj, "Mesh") and obj.Mesh is not None and len(obj.Mesh.Topology[0]) > 0:
                    meshes.append(obj.Mesh)
                elif hasattr(obj, "Shape") and obj.Shape is not None and not obj.Shape.isNull():
                    meshes.append(Mesh.Mesh(obj.Shape.tessellate(tolerance)[0]))
            except Exception:
                continue

        if not meshes:
            return False, "No tessellatable geometry found (empty or unsupported features)."

        Mesh.export(meshes, str(output_path))
    except Exception as exc:
        return False, f"Conversion error: {exc}"
    finally:
        try:
            FreeCAD.closeDocument(doc.Name)
        except Exception:
            pass

    if not os.path.exists(output_path):
        return False, "STL file was not created."
    return True, f"Successfully converted to STL: {output_path}"


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("Usage: freecad_cad_convert.py <input.cad> <output.stl> <tolerance_mm>")
        sys.exit(1)

    try:
        tolerance_mm = float(sys.argv[3])
    except ValueError:
        print("tolerance_mm must be a number.")
        sys.exit(1)
    if tolerance_mm <= 0:
        print("tolerance_mm must be positive.")
        sys.exit(1)

    success, message = convert_cad_to_stl(sys.argv[1], sys.argv[2], tolerance_mm)
    print(message)
    sys.exit(0 if success else 1)
