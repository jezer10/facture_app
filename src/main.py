import requests
from jinja2 import Environment, FileSystemLoader
from playwright.sync_api import sync_playwright

import pdfkit
from urllib.parse import urlencode

options = {
    "page-size": "A4",
    "encoding": "UTF-8",
    "margin-top": "4mm",
    "margin-right": "4mm",
    "margin-bottom": "4mm",
    "margin-left": "4mm",
    "enable-local-file-access": "",
}


auth_token = "eyJraWQiOiJhcGkuc3VuYXQuZ29iLnBlLmtpZDAwMSIsInR5cCI6IkpXVCIsImFsZyI6IlJTMjU2In0.eyJzdWIiOiIyMDYwMjY5ODI3MSIsImF1ZCI6Ilt7XCJhcGlcIjpcImh0dHBzOlwvXC9hcGktY3BlLnN1bmF0LmdvYi5wZVwiLFwicmVjdXJzb1wiOlt7XCJpZFwiOlwiXC92MVwvY29udHJpYnV5ZW50ZVwvY29uc3VsdGFjcGVcIixcImluZGljYWRvclwiOlwiMVwiLFwiZ3RcIjpcIjEwMDEwMFwifSx7XCJpZFwiOlwiXC92MVwvY29udHJpYnV5ZW50ZVwvcGFyYW1ldHJvc1wiLFwiaW5kaWNhZG9yXCI6XCIxXCIsXCJndFwiOlwiMTAwMTAwXCJ9XX1dIiwidXNlcmRhdGEiOnsibnVtUlVDIjoiMjA2MDI2OTgyNzEiLCJ0aWNrZXQiOiIxMzE5MDAxNDAxOTQ0IiwibnJvUmVnaXN0cm8iOiIiLCJhcGVNYXRlcm5vIjoiIiwibG9naW4iOiIyMDYwMjY5ODI3MUFSUkVUSUNJIiwibm9tYnJlQ29tcGxldG8iOiJNRUdBIE5BVFVSQUwgUy5BLkMuIiwibm9tYnJlcyI6Ik1FR0EgTkFUVVJBTCBTLkEuQy4iLCJjb2REZXBlbmQiOiIwMDIzIiwiY29kVE9wZUNvbWVyIjoiIiwiY29kQ2F0ZSI6IiIsIm5pdmVsVU8iOjAsImNvZFVPIjoiIiwiY29ycmVvIjoiIiwidXN1YXJpb1NPTCI6IkFSUkVUSUNJIiwiaWQiOiIiLCJkZXNVTyI6IiIsImRlc0NhdGUiOiIiLCJhcGVQYXRlcm5vIjoiIiwiaWRDZWx1bGFyIjpudWxsLCJtYXAiOnsiaXNDbG9uIjpmYWxzZSwiZGRwRGF0YSI6eyJkZHBfbnVtcnVjIjoiMjA2MDI2OTgyNzEiLCJkZHBfbnVtcmVnIjoiMDAyMyIsImRkcF9lc3RhZG8iOiIwMCIsImRkcF9mbGFnMjIiOiIwMCIsImRkcF91YmlnZW8iOiIxNTA1MDUiLCJkZHBfdGFtYW5vIjoiMDMiLCJkZHBfdHBvZW1wIjoiMzkiLCJkZHBfY2lpdSI6IjE1MzE2In0sImlkTWVudSI6IjEzMTkwMDE0MDE5NDQiLCJqbmRpUG9vbCI6InAwMDIzIiwidGlwVXN1YXJpbyI6IjAiLCJ0aXBPcmlnZW4iOiJJVCIsInByaW1lckFjY2VzbyI6ZmFsc2V9fSwibmJmIjoxNzMxNTYxMjQ2LCJjbGllbnRJZCI6ImNkOGU3YWZiLWEwZTItNDIxNy05MTg3LTg4MjA2ZTRiYTdhZiIsImlzcyI6Imh0dHBzOlwvXC9hcGktc2VndXJpZGFkLnN1bmF0LmdvYi5wZVwvdjFcL2NsaWVudGVzc29sXC9jZDhlN2FmYi1hMGUyLTQyMTctOTE4Ny04ODIwNmU0YmE3YWZcL29hdXRoMlwvdG9rZW5cLyIsImV4cCI6MTczMTU2NDg0NiwiZ3JhbnRUeXBlIjoiYXV0aG9yaXphdGlvbl90b2tlbiIsImlhdCI6MTczMTU2MTI0Nn0.Tq--3LzDNYwgRNnvqoEpPavYTI2BEQgSmPYlTaKh_VOhS0fc34pisrpOuuVXmiB82OLmRX5Z-Re-kL__FDNwA5xxX8q-9d2fuClnvr6FFKm64tVYjYKgvM3Y_TX-FVx5Pr0t_eS1MBZWcHYyKQ0YQoo80VZm2kINY5-x1iWEVKrlYQznz_B9CSuXYx_zYRvFBZxfYHCCCa-rb_b74TrEbXv5rS9UNSPhc7AcWjLJouPeheIciyjiqL43mNZNzL4BrI6yGH-qw4cM3yopbUhpq4lWsCBlye7PrrGdh4ePcA2JHSkPT-feuZREdeV-rbyS_sxv8w1u24lfWCiNhS-JQg"
base_url = "https://api-cpe.sunat.gob.pe/v1/contribuyente/consultacpe/comprobantes"


def get_documents(
    start_date, end_date, document_type="01", document_source=2, document_status=0
):
    q = {
        "codEstado": document_status,
        "fecEmisionIni": start_date,
        "fecEmisionFin": end_date,
    }
    response = requests.get(
        f"{base_url}/-{document_type}-{document_source}?{urlencode(q)}",
        headers={"Authorization": f"Bearer {auth_token}"},
    )
    print(response.status_code)
    if response.status_code == 200:
        comprobantes = response.json().get("comprobantes", [])
        comprobantes = [
            f"{comprobante.get("datosEmisor", {}).get("numRuc")}-{document_type}-{comprobante.get("numSerie")}-{comprobante.get("numCpe")}-{document_source}"
            for comprobante in comprobantes
        ]
        for comprobante in comprobantes[:1]:
            response = requests.get(
                f"{base_url}/{comprobante}",
                headers={"Authorization": f"Bearer {auth_token}"},
            )
            print(response.status_code)
            if response.status_code == 200:
                (content,) = response.json().get("comprobantes", [])
                issuer = content.get("datosEmisor", {})
                receiver = content.get("datosReceptor", {})
                items = content.get("informacionItems", [])
                detractions = content.get("informacionDetraccion", [])

                resume = content.get("procedenciaMasiva", {})

                variables = {
                    "issuer": {
                        "name": issuer.get("desRazonSocialEmis"),
                        "comercial_name": issuer.get("desNomComercialEmis"),
                        "address": issuer.get("desDirEmis"),
                        "location": issuer.get("ubigeoEmis"),
                        "ruc": issuer.get("numRuc"),
                    },
                    "receiver": {
                        "name": receiver.get("desRazonSocialRecep"),
                        "address": receiver.get("dirDetCliente"),
                        "ruc": receiver.get("numDocIdeRecep"),
                    },
                    "comment": content.get("desObservacion"),
                    "issue_date": content.get("fecEmision"),
                    "iso_currency_code": content.get("codMoneda"),
                    "total_amount_text": content.get("desMtoTotalLetras"),
                    "serial_number": content.get("numSerie"),
                    "document_number": content.get("numCpe"),
                    "transaction_type": content.get("codTipTransaccion"),
                    "detraction": [
                        {
                            "label": detraction.get("desLeyenda"),
                            "service": detraction.get("desBienServicio"),
                            "payment_method": detraction.get("medioPago"),
                            "account_number": detraction.get("nroCuenta"),
                            "percentage": detraction.get("porDetraccion"),
                            "amount": detraction.get("mtoDetraccion"),
                        }
                        for detraction in detractions
                    ],
                    "items": [
                        {
                            "code": item.get("desCodigo"),
                            "description": item.get("desItem"),
                            "quantity": item.get("cntItems"),
                            "measure": item.get("desUnidadMedida"),
                            "unit_value": item.get("mtoValUnitario"),
                            "icbper": item.get("mtoICBPER"),
                        }
                        for item in items
                    ],
                    "summary": {
                        "global_affected_discount": resume.get("mtoDtoGlobalAfecBI"),
                        "total_taxed_sales_value": resume.get(
                            "mtoTotalValVentaGrabado"
                        ),
                        "total_unaffected_sales_value": resume.get(
                            "mtoTotalValVentaInafecto"
                        ),
                        "total_exonerated_sales_value": resume.get(
                            "mtoTotalValVentaExonerado"
                        ),
                        "total_free_sales_value": resume.get(
                            "mtoTotalValVentaGratuito"
                        ),
                        "total_exportation_sales_value": resume.get(
                            "mtoTotalValVentaExportacion"
                        ),
                        "global_unaffected_discount": resume.get(
                            "mtoDtoGlobalNoAfecBI"
                        ),
                        "total_discount": resume.get("mtoTotalDtos"),
                        "other_taxes_addition": resume.get("mtoSumOtrosTributos"),
                        "other_charges_addition": resume.get("mtoSumOtrosCargos"),
                        "isc_addition": resume.get("mtoSumISC"),
                        "igv_addition": resume.get("mtoSumIGV"),
                        "icbper_addition": resume.get("mtoSumICBPER"),
                        "total_advance_amount": resume.get("mtoTotalAnticipo"),
                        "rounded_amount": resume.get("mtoRedondeo"),
                        "total": resume.get("mtoImporteTotal"),
                    },
                }

                template = Environment(loader=FileSystemLoader(".")).get_template(
                    "src/assets/templates/index.html"
                )
                html_content = template.render(variables)
                with sync_playwright() as p:
                    browser = p.chromium.launch()
                    page = browser.new_page()
                    page.set_content(html_content)
                    page.pdf(
                        path="documento_dinamico.pdf",
                        format="A4",
                        print_background=True
                    )

                    browser.close()
                


get_documents("31/10/2024", "31/10/2024")
