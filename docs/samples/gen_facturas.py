from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.colors import HexColor
import os

OUT = "/tmp/claude-0/-home-user-GestOpClientes/6476ea49-bc1d-5c20-b9c7-b8b661398e07/scratchpad"
W, H = A4
INK = HexColor("#1a1a1a"); GREY = HexColor("#8a8a8a"); LINE = HexColor("#cccccc"); BOX = HexColor("#f4f4f4")

def draw_factura(c):
    m = 18*mm
    # Marco
    c.setStrokeColor(LINE); c.setLineWidth(1)
    c.rect(m, m, W-2*m, H-2*m)
    # Encabezado
    c.setFillColor(INK); c.setFont("Helvetica-Bold", 20)
    c.drawString(m+8*mm, H-m-14*mm, "LOEKEMEYER HNOS. S.R.L.")
    c.setFont("Helvetica", 9); c.setFillColor(GREY)
    c.drawString(m+8*mm, H-m-20*mm, "Modelo de prueba — SIN VALIDEZ FISCAL")
    # Recuadro tipo comprobante (centro)
    bx = W/2 - 12*mm
    c.setStrokeColor(INK); c.setLineWidth(1.4)
    c.rect(bx, H-m-26*mm, 24*mm, 18*mm)
    c.setFillColor(INK); c.setFont("Helvetica-Bold", 26)
    c.drawCentredString(W/2, H-m-20*mm, "X")
    c.setFont("Helvetica", 7); c.drawCentredString(W/2, H-m-24.5*mm, "COD. 00")
    # Factura N° / Fecha
    c.setFont("Helvetica-Bold", 13)
    c.drawRightString(W-m-8*mm, H-m-14*mm, "FACTURA")
    c.setFont("Helvetica", 9)
    for i,(lbl) in enumerate(["Punto de Venta: 0000    Comp. Nro: 00000000",
                              "Fecha de Emisión: __/__/____",
                              "CUIT: __-________-_    IIBB: ____"]):
        c.drawRightString(W-m-8*mm, H-m-20*mm-i*5*mm, lbl)
    # Datos cliente
    y = H-m-40*mm
    c.setFillColor(BOX); c.rect(m+6*mm, y-22*mm, W-2*m-12*mm, 22*mm, fill=1, stroke=0)
    c.setFillColor(INK); c.setFont("Helvetica-Bold", 9)
    c.drawString(m+9*mm, y-5*mm, "Cliente:")
    c.setFont("Helvetica", 9); c.setFillColor(GREY)
    for i,l in enumerate(["Razón Social: ______________________________",
                          "CUIT/DNI: ______________   Cond. IVA: ______________",
                          "Domicilio: ______________________________"]):
        c.drawString(m+24*mm, y-5*mm-i*5.5*mm, l)
    # Tabla items
    ty = y-30*mm
    c.setFillColor(INK); c.setFont("Helvetica-Bold", 8)
    cols = [("Código", m+9*mm), ("Descripción", m+30*mm), ("Cant.", W-m-70*mm),
            ("P. Unit.", W-m-48*mm), ("Importe", W-m-24*mm)]
    c.setStrokeColor(INK); c.setLineWidth(0.8)
    c.line(m+6*mm, ty, W-m-6*mm, ty)
    for t,x in cols: c.drawString(x, ty+2*mm, t)
    c.line(m+6*mm, ty-2*mm, W-m-6*mm, ty-2*mm)
    c.setStrokeColor(LINE); c.setLineWidth(0.4)
    for r in range(8):
        yy = ty-2*mm-(r+1)*7*mm
        c.line(m+6*mm, yy, W-m-6*mm, yy)
    # Totales
    by = ty-2*mm-8*7*mm-4*mm
    c.setFont("Helvetica", 9); c.setFillColor(INK)
    tot = [("Subtotal (Neto):", "$ ____________"),
           ("IVA 21%:", "$ ____________"),
           ("TOTAL:", "$ ____________")]
    for i,(lbl,val) in enumerate(tot):
        yy = by-i*6*mm
        c.setFont("Helvetica-Bold" if i==2 else "Helvetica", 10 if i==2 else 9)
        c.drawRightString(W-m-40*mm, yy, lbl)
        c.drawRightString(W-m-9*mm, yy, val)
    # CAE
    c.setFont("Helvetica", 8); c.setFillColor(GREY)
    c.drawString(m+9*mm, m+8*mm, "CAE N°: ____________________    Vto. CAE: __/__/____")
    c.drawRightString(W-m-9*mm, m+8*mm, "MODELO DE PRUEBA")

# 1) una hoja
c1 = canvas.Canvas(os.path.join(OUT,"factura_modelo_vacia.pdf"), pagesize=A4)
draw_factura(c1); c1.showPage(); c1.save()

# 2) tres hojas iguales
c3 = canvas.Canvas(os.path.join(OUT,"factura_modelo_combinada_3.pdf"), pagesize=A4)
for _ in range(3):
    draw_factura(c3); c3.showPage()
c3.save()

for f in ["factura_modelo_vacia.pdf","factura_modelo_combinada_3.pdf"]:
    p=os.path.join(OUT,f); print(f, os.path.getsize(p), "bytes")
