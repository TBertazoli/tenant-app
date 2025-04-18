import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

interface FormData {
  landlordName: string
  landlordEmail: string
  tenantName: string
  tenantEmail: string
  propertyAddress: string
  leaseStartDate: string
  leaseEndDate: string
  monthlyRent: string
  securityDeposit: string
  apartmentNumber?: string
}

interface DocumensoRecipient {
  email: string
  name: string
  status?: string
  role?: string
}

interface DocumensoResponse {
  documentId: number
  uploadUrl?: string
  recipients: DocumensoRecipient[]
  status?: string
  createdAt?: string
  updatedAt?: string
  metadata?: Record<string, unknown>
  signingUrl?: string
}

export async function POST(request: NextRequest) {
  try {
    const formData: FormData = await request.json();

    const requiredFields: (keyof FormData)[] = [
      'landlordName',
      'landlordEmail',
      'tenantName',
      'tenantEmail',
      'propertyAddress',
      'leaseStartDate',
      'leaseEndDate',
      'monthlyRent',
    ];

    const missingFields = requiredFields.filter(field => !formData[field])
    if (missingFields.length > 0) {
      return NextResponse.json(
        { success: false, error: `Missing required fields: ${missingFields.join(', ')}` },
        { status: 400 }
      )
    }

    let apartmentNumber = formData.apartmentNumber;
    if (!apartmentNumber) {
      const match = formData.propertyAddress.match(/Apartment\s+(\d+)/i);
      if (match && match[1]) {
        apartmentNumber = match[1];
      } else {
        return NextResponse.json(
          { success: false, error: 'Apartment number is required' },
          { status: 400 }
        );
      }
    }

    const pdfDoc = await PDFDocument.create()
    const page = pdfDoc.addPage([600, 800])
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica)
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

    page.drawText('RESIDENTIAL LEASE AGREEMENT', {
      x: 50,
      y: 750,
      size: 16,
      font: boldFont,
    })

    const contentLines = [
      { text: `THIS LEASE AGREEMENT made this ${new Date().toLocaleDateString()}`, y: 720 },
      { text: `BETWEEN:`, y: 700 },
      { text: `${formData.landlordName} (Landlord)`, y: 680 },
      { text: `AND:`, y: 660 },
      { text: `${formData.tenantName} (Tenant)`, y: 640 },
      { text: `FOR THE PREMISES AT:`, y: 620 },
      { text: `${formData.propertyAddress}`, y: 600 },
      { text: `TERM:`, y: 580 },
      { text: `From ${formData.leaseStartDate} to ${formData.leaseEndDate}`, y: 560 },
      { text: `RENT:`, y: 540 },
      { text: `$${formData.monthlyRent} per month, payable on the 1st day of each month`, y: 520 },
      { text: `SECURITY DEPOSIT:`, y: 500 },
      { text: `$${formData.securityDeposit || formData.monthlyRent}`, y: 480 },
      { text: `The parties agree to the terms of this lease.`, y: 460 },
      { text: `This document requires digital signature from all parties.`, y: 440 },
    ]

    contentLines.forEach(line => {
      page.drawText(line.text, {
        x: 50,
        y: line.y,
        size: 12,
        font: font,
        color: rgb(0, 0, 0),
      })
    })

    const pdfBytes = await pdfDoc.save()
    const fileBuffer = Buffer.from(pdfBytes)

    const tempDir = os.tmpdir()
    const tempFilePath = path.join(tempDir, `lease_${Date.now()}.pdf`)
    await fs.writeFile(tempFilePath, fileBuffer)

    const documentTitle = `Lease Agreement - Apartment ${apartmentNumber}`
    const documensoData = await sendToDocumenso(documentTitle, formData.tenantName, formData.tenantEmail, fileBuffer)
    const property = await prisma.property.findFirst({
      where: {
        email: formData.landlordEmail,
      },
    });

    if (!property) {
      return NextResponse.json(
        { success: false, error: "Property not found" },
        { status: 404 }
      );
    }

    await prisma.lease.create({
      data: {
        firstName: formData.tenantName.split(' ')[0],
        lastName: formData.tenantName.split(' ').slice(1).join(' '),
        email: formData.tenantEmail,
        securityDeposit: formData.securityDeposit,
        apartmentNumber: apartmentNumber,
        leaseStart: new Date(formData.leaseStartDate),
        leaseEnd: new Date(formData.leaseEndDate),
        monthlyRent: formData.monthlyRent,
        leaseStatus: "PENDING",
        propertyId: property.id,
        createdAt: new Date(),
      },
    });

    try {
      await fs.unlink(tempFilePath)
    } catch (deleteError) {
      console.warn("Failed to delete temp file:", deleteError)
    }

    return NextResponse.json({
      success: true,
      documentId: documensoData.documentId,
      redirectUrl: `/confirmation?id=${documensoData.documentId}&email=${encodeURIComponent(formData.tenantEmail)}&name=${encodeURIComponent(formData.tenantName)}`,
      documensoData
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('Error generating lease:', error)
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  } finally {
    await prisma.$disconnect()
  }
}

async function sendToDocumenso(
  documentTitle: string,
  tenantName: string,
  tenantEmail: string,
  fileBuffer: Buffer
): Promise<DocumensoResponse> {
  const base64Pdf = fileBuffer.toString('base64');

  if (!process.env.DOCUMENSO_API_KEY) {
    return {
      documentId: Date.now(),
      status: 'DRAFT',
      recipients: [
        {
          email: tenantEmail,
          name: tenantName,
          status: 'PENDING',
        },
      ],
    }
  }

  const apiKey = process.env.DOCUMENSO_API_KEY

  const createResponse = await fetch('https://app.documenso.com/api/v1/documents', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: documentTitle,
      recipients: [{ email: tenantEmail, name: tenantName, role: 'SIGNER' }],
      fileName: `${documentTitle}.pdf`,
      redirectUrl: null,
      timezone: 'America/Chicago',
      dateFormat: 'MM/DD/YYYY',
      documentLength: base64Pdf.length,
    }),
  })

  if (!createResponse.ok) {
    const errorData = await createResponse.json()
    throw new Error(`Documenso API error: ${errorData.message || createResponse.statusText}`)
  }

  const docResponse: DocumensoResponse = await createResponse.json()

  if (docResponse.uploadUrl) {
    const uploadResponse = await fetch(docResponse.uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/pdf',
      },
      body: fileBuffer,
    })

    if (!uploadResponse.ok) {
      throw new Error(`Failed to upload PDF to Documenso: ${uploadResponse.statusText}`)
    }
  }

  const sendResponse = await fetch(`https://app.documenso.com/api/v1/documents/${docResponse.documentId}/send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      subject: `Lease Agreement for ${tenantName}`,
      message: `Please review and sign your lease agreement.`,
    }),
  })

  if (!sendResponse.ok) {
    const errorData = await sendResponse.json()
    throw new Error(`Documenso API error: ${errorData.message || sendResponse.statusText}`)
  }
  
  return docResponse;
}
