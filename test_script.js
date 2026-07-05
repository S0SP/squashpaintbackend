const fs = require('fs');
const path = require('path');

async function run() {
    try {
        console.log("Processing image through local backend...");
        const inputPath = "C:\\Users\\sumit\\.gemini\\antigravity-ide\\brain\\9a521ed0-edee-4ec6-9ba2-9dd1e6c89682\\sample_fox_input_1783245463861.png";
        const formData = new FormData();
        const fileBuffer = fs.readFileSync(inputPath);
        formData.append('image', new Blob([fileBuffer], { type: 'image/png' }), 'upload.png');
        formData.append('settings', JSON.stringify({ kMeansNrOfClusters: 16 }));

        const procRes = await fetch('http://127.0.0.1:3000/api/process', {
            method: 'POST',
            body: formData
        });
        if (!procRes.ok) {
            console.error("Failed to process:", await procRes.text());
            return;
        }
        const procData = await procRes.json();
        const outputPath = "C:\\Users\\sumit\\.gemini\\antigravity-ide\\brain\\9a521ed0-edee-4ec6-9ba2-9dd1e6c89682\\sample_fox_output.jpeg";
        fs.writeFileSync(outputPath, Buffer.from(procData.thumbnail_b64, 'base64'));
        console.log("Saved processed color-by-numbers output to sample_fox_output.jpeg");

    } catch (e) {
        console.error(e);
    }
}
run();
