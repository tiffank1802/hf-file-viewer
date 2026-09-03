"""
Client example for calling the SolidWorks to GLB Converter Space

This Python example shows how to call the Hugging Face Space from your 
backend server. Never expose HF_TOKEN to the client side.

Install dependencies:
    pip install gradio_client
"""

from gradio_client import Client
from typing import Optional
import os


def convert_sldprt_to_glb(
    sldprt_file_path: str,
    hf_space_name: str,
    hf_token: Optional[str] = None
) -> str:
    """
    Convert a SolidWorks .sldprt file to GLB using the Hugging Face Space.
    
    Args:
        sldprt_file_path: Path to the .sldprt file on your server
        hf_space_name: Hugging Face Space name (e.g., "username/sldprt-to-glb")
        hf_token: Optional HF token for private spaces
    
    Returns:
        str: Path/URL to the converted .glb file
    
    Raises:
        TimeoutError: If conversion takes too long (complex part)
        ConnectionError: If space is unavailable or rate limited
        ValueError: If file format is invalid
    """
    try:
        # Create client with optional token for private spaces
        if hf_token:
            client = Client(hf_space_name, hf_token=hf_token)
        else:
            client = Client(hf_space_name)
        
        print(f"Converting {sldprt_file_path} to GLB...")
        
        # Call the Space API
        result = client.predict(
            uploaded_file=sldprt_file_path,
            api_name="/process_file"
        )
        
        print("Conversion successful!")
        print(f"GLB file: {result}")
        
        return result
        
    except Exception as e:
        error_msg = str(e)
        
        # Handle common errors
        if "timeout" in error_msg.lower():
            raise TimeoutError(
                "Conversion timed out. The part may be too complex."
            ) from e
        
        if "429" in error_msg:
            raise ConnectionError(
                "Rate limit exceeded. Please wait before trying again."
            ) from e
        
        if "cold start" in error_msg.lower() or "starting" in error_msg.lower():
            raise ConnectionError(
                "Space is starting up. This may take 30-60 seconds on first request."
            ) from e
        
        raise


# Flask endpoint example
def create_flask_endpoint():
    """
    Example Flask endpoint for converting files.
    
    Usage in your Flask app:
        from convert_client import create_flask_endpoint
        app.add_url_rule('/api/convert-sldprt', 'convert_sldprt', 
                        create_flask_endpoint(), methods=['POST'])
    """
    from flask import Flask, request, jsonify
    
    def convert_endpoint():
        try:
            if 'file' not in request.files:
                return jsonify({
                    'status': 'error',
                    'message': 'No file uploaded'
                }), 400
            
            file = request.files['file']
            
            if file.filename == '':
                return jsonify({
                    'status': 'error',
                    'message': 'No file selected'
                }), 400
            
            if not file.filename.lower().endswith('.sldprt'):
                return jsonify({
                    'status': 'error',
                    'message': 'Invalid file format. Expected .sldprt'
                }), 400
            
            # Save uploaded file temporarily
            import tempfile
            temp_dir = tempfile.mkdtemp()
            temp_path = os.path.join(temp_dir, file.filename)
            file.save(temp_path)
            
            # Configuration
            HF_SPACE_NAME = "your-username/sldprt-to-glb"
            HF_TOKEN = os.environ.get('HF_TOKEN')  # Store in environment variable
            
            print(f"Processing file: {temp_path}")
            
            # Perform conversion
            glb_path = convert_sldprt_to_glb(temp_path, HF_SPACE_NAME, HF_TOKEN)
            
            # Return the GLB URL/path to the client
            return jsonify({
                'status': 'success',
                'glbUrl': glb_path,
                'message': 'File converted successfully'
            })
            
        except TimeoutError as e:
            return jsonify({
                'status': 'error',
                'message': str(e)
            }), 408  # Request Timeout
        
        except ConnectionError as e:
            return jsonify({
                'status': 'error',
                'message': str(e)
            }), 503  # Service Unavailable
        
        except ValueError as e:
            return jsonify({
                'status': 'error',
                'message': str(e)
            }), 400  # Bad Request
        
        except Exception as e:
            print(f"Conversion error: {e}")
            return jsonify({
                'status': 'error',
                'message': 'Conversion failed'
            }), 500  # Internal Server Error
    
    return convert_endpoint


if __name__ == "__main__":
    # Example usage
    HF_SPACE_NAME = "your-username/sldprt-to-glb"
    HF_TOKEN = os.environ.get("HF_TOKEN")
    
    try:
        glb_path = convert_sldprt_to_glb(
            "./example-part.sldprt",
            HF_SPACE_NAME,
            HF_TOKEN
        )
        print(f"Converted file available at: {glb_path}")
    except Exception as e:
        print(f"Error: {e}")
