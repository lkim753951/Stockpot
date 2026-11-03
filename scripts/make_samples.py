#!/usr/bin/env python3
"""Builds the sample call, delivery note and invoice. All names and prices are fictional."""
import json, subprocess, tempfile, wave
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "public" / "samples"
RATE = 24000
GAP = 0.45

TURNS = [
    ("A", "kal", "Morning Dave, it's Sam at Sample Kitchen. This call's recorded for our order records, is that OK?"),
    ("B", "awb", "No problem Sam. What can I get you for Thursday?"),
    ("A", "kal", "Twenty kilos of chicken thighs please. What's the price this week?"),
    ("B", "awb", "Thighs have gone up. They're six ninety a kilo now."),
    ("A", "kal", "Six ninety? I paid six forty last week, and Northgate are doing them at six ten. Can you match six forty?"),
    ("B", "awb", "Go on then, six forty a kilo for you this week."),
    ("A", "kal", "Thank you. And ten kilos of brown onions."),
    ("B", "awb", "Onions are eighty five pence a kilo, same as last time. All on the van Thursday morning."),
    ("A", "kal", "Perfect, thanks Dave."),
]


def speak(text, voice, path):
    safe = text.replace("'", "").replace(":", "")
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", f"flite=text='{safe}':voice={voice}",
         "-ar", str(RATE), "-ac", "1", "-c:a", "pcm_s16le", str(path)], check=True)


def save_clip(command, path):
    """Saves spoken words as the mono 16-bit 24 kHz WAV that Muse Voice Transcribe takes."""
    subprocess.run(command, check=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(path) + ".raw.wav", "-ar", str(RATE), "-ac", "1",
                    "-c:a", "pcm_s16le", "-bitexact", "-map_metadata", "-1", str(path)], check=True)
    Path(str(path) + ".raw.wav").unlink()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    save_clip(["espeak-ng", "-v", "en-gb", "-s", "150", "-w", str(OUT / "sample-fridge.wav") + ".raw.wav", "Fridge two is at nine degrees."], OUT / "sample-fridge.wav")
    save_clip(["espeak-ng", "-v", "pl", "-s", "140", "-w", str(OUT / "sample-report.wav") + ".raw.wav",
          "Druga lodówka nie chłodzi, temperatura wciąż rośnie i jedzenie może się zepsuć."], OUT / "sample-report.wav")
    pcm = bytearray()
    script = []
    silence = bytes(int(RATE * GAP) * 2)
    pcm += silence
    with tempfile.TemporaryDirectory() as tmp:
        for index, (speaker, voice, text) in enumerate(TURNS, 1):
            path = Path(tmp) / f"{index}.wav"
            speak(text, voice, path)
            with wave.open(str(path)) as clip:
                frames = clip.readframes(clip.getnframes())
            start = len(pcm) / 2 / RATE
            pcm += frames + silence
            end = (len(pcm) - len(silence)) / 2 / RATE
            script.append({"turn": index, "speaker": speaker, "startMs": round(start * 1000), "endMs": round(end * 1000), "text": text})
    with wave.open(str(OUT / "sample-call.wav"), "wb") as out:
        out.setnchannels(1); out.setsampwidth(2); out.setframerate(RATE); out.writeframes(bytes(pcm))
    (OUT / "sample-call.json").write_text(json.dumps(script, indent=2))

    from playwright.sync_api import sync_playwright
    fonts = "font-family:Georgia,'Times New Roman',serif;"
    invoice = f"""<body style="margin:0;background:#fff;{fonts}color:#222;width:760px;padding:44px;box-sizing:border-box">
    <div style="display:flex;justify-content:space-between"><div><div style="font-size:30px;font-weight:bold">Harrow Lane Foods</div>
    <div>Unit 4, Harrow Lane Trading Estate</div><div>Sample document, not a real company</div></div>
    <div style="text-align:right"><div style="font-size:24px">INVOICE</div><div>No. HLF-20418</div><div>Date: DATE</div></div></div>
    <p style="margin-top:28px"><b>Bill to:</b> Sample Kitchen</p>
    <table style="width:100%;border-collapse:collapse;margin-top:16px;font-size:17px"><tr style="border-bottom:2px solid #222;text-align:left">
    <th style="padding:8px 0">Description</th><th>Qty</th><th>Unit</th><th>Price</th><th style="text-align:right">Total</th></tr>
    <tr style="border-bottom:1px solid #bbb"><td style="padding:10px 0">Chicken thighs, boneless</td><td>20</td><td>kg</td><td>£6.90</td><td style="text-align:right">£138.00</td></tr>
    <tr style="border-bottom:1px solid #bbb"><td style="padding:10px 0">Brown onions</td><td>10</td><td>kg</td><td>£0.85</td><td style="text-align:right">£8.50</td></tr></table>
    <div style="margin-top:20px;text-align:right;font-size:17px"><div>Net: £146.50</div><div>VAT at 0%: £0.00</div><div style="font-size:21px;font-weight:bold">Total: £146.50</div></div>
    <p style="margin-top:40px;font-size:14px">Payment terms 14 days.</p></body>"""
    note = f"""<body style="margin:0;background:#f6f2e7;{fonts}color:#222;width:760px;padding:44px;box-sizing:border-box;position:relative">
    <div style="font-size:26px;font-weight:bold">Harrow Lane Foods delivery note</div><div>To: Sample Kitchen. Sample document, not a real company.</div>
    <table style="width:100%;border-collapse:collapse;margin-top:26px;font-size:18px"><tr style="border-bottom:2px solid #222;text-align:left"><th style="padding:8px 0">Item</th><th>Ordered</th><th>Received</th></tr>
    <tr style="border-bottom:1px solid #999"><td style="padding:14px 0">Chicken thighs</td><td>20 kg</td>
    <td><span style="text-decoration:line-through">20 kg</span> <span style="font-family:'Comic Sans MS',cursive;color:#1a3fa0;font-size:26px;transform:rotate(-4deg);display:inline-block">18 kg</span></td></tr>
    <tr style="border-bottom:1px solid #999"><td style="padding:14px 0">Brown onions</td><td>10 kg</td><td>10 kg</td></tr></table>
    <p style="font-family:'Comic Sans MS',cursive;color:#1a3fa0;font-size:21px;margin-top:30px;transform:rotate(-1.5deg)">2 kg short, driver says back order</p>
    <p style="margin-top:34px">Signed: S. Kitchen</p></body>"""
    import datetime
    today = datetime.date.today().strftime("%d/%m/%Y")
    previous = invoice.replace("HLF-20418", "HLF-20377").replace(
        """<tr style="border-bottom:1px solid #bbb"><td style="padding:10px 0">Brown onions</td><td>10</td><td>kg</td><td>£0.85</td><td style="text-align:right">£8.50</td></tr>""", "").replace(
        "£6.90", "£6.40").replace("£138.00", "£128.00").replace("£146.50", "£128.00")
    def receipt(shop, number, rows, total):
        lines = "".join(f'<div style="display:flex;justify-content:space-between;margin:10px 0"><span>{a}</span><span>{b}</span></div>' for a, b in rows)
        return f"""<body style="margin:0;background:#d9d6d0;display:flex;justify-content:center;font-family:'Courier New',monospace;color:#222">
        <div style="width:380px;background:#fff;margin:24px 0;padding:28px;box-shadow:0 2px 8px rgba(0,0,0,.2);font-size:17px">
        <div style="text-align:center;font-size:22px;font-weight:bold">{shop}</div><div style="text-align:center;font-size:13px">Sample document, not a real company</div>
        <div style="margin:14px 0 6px">Receipt {number}</div><div>Date: DATE</div><hr style="border:0;border-top:1px dashed #555;margin:14px 0">
        {lines}<hr style="border:0;border-top:1px dashed #555;margin:14px 0">
        <div style="display:flex;justify-content:space-between;font-weight:bold;font-size:20px"><span>TOTAL</span><span>{total}</span></div></div></body>"""
    northgate = receipt("Northgate Wholesale", "NG-7741", [("5 kg Basmati rice @ £1.95", "£9.25"), ("4 l Rapeseed oil @ £1.60", "£6.40")], "£15.65")
    oakfield = receipt("Oakfield Dairy", "OD-1183", [("6 l Double cream @ £3.20", "£19.20")], "£19.20")
    thermometer = """<body style="margin:0;width:520px;height:360px;display:flex;align-items:center;justify-content:center;background:#c9ced3;font-family:Arial,sans-serif">
    <div style="background:#2b2f33;border-radius:18px;padding:26px 34px;box-shadow:0 6px 18px rgba(0,0,0,.35)">
    <div style="color:#cfd4d8;font-size:17px;letter-spacing:.08em;margin-bottom:10px">FRIDGE 2</div>
    <div style="background:#9fb39a;border-radius:8px;padding:12px 34px;font-size:96px;font-family:'Courier New',monospace;font-weight:bold;color:#1c261b">9.0°C</div></div></body>"""
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 760, "height": 620})
        page.set_content(invoice.replace("DATE", today)); page.screenshot(path=str(OUT / "sample-invoice.png"))
        page.set_viewport_size({"width": 760, "height": 520})
        page.set_content(note); page.screenshot(path=str(OUT / "sample-delivery-note.png"))
        page.set_viewport_size({"width": 760, "height": 560})
        page.set_content(previous.replace("DATE", "last week")); page.screenshot(path=str(OUT / "sample-invoice-previous.png"))
        page.set_viewport_size({"width": 500, "height": 480})
        page.set_content(northgate.replace("DATE", today)); page.screenshot(path=str(OUT / "sample-receipt-northgate.png"))
        page.set_viewport_size({"width": 500, "height": 420})
        page.set_content(oakfield.replace("DATE", today)); page.screenshot(path=str(OUT / "sample-receipt-oakfield.png"))
        page.set_viewport_size({"width": 520, "height": 360})
        page.set_content(thermometer); page.screenshot(path=str(OUT / "sample-thermometer.png"))
        browser.close()
    print("call seconds", len(pcm) / 2 / RATE)


if __name__ == "__main__":
    main()
