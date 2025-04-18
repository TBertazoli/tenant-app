import { prisma } from "../../../utils/prisma";
import { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const { method } = req;

  switch (method) {
    case "GET":
      try {
        const { userRole } = req.query;
        if (userRole === "tenant") {
          const tenant = await prisma.user.findMany({
            where: {
              userRole: "TENANT",
            },
          });
          return res.status(200).json(tenant);
        }
        const users = await prisma.user.findMany();
        res.status(200).json(users);
      } catch (error) {
        console.error("Error finding user:", error);
        res.status(500).json({ error: "failed to fetch users" });
      }
      break;

    case "POST":
      try {
        const {
          appwriteId,
          firstName,
          lastName,
          email,
          apartmentNumber,
          phoneNumber,
        } = req.body;

        const requiredFields = [
          "firstName",
          "lastName",
          "email",
          "apartmentNumber",
        ];
        const missingFields = requiredFields.filter(
          (field) => !req.body[field]
        );

        if (missingFields.length > 0) {
          return res
            .status(400)
            .json({ error: `Missing fields: ${missingFields.join(", ")}` });
        }

        const existingUser = await prisma.user.findUnique({
          where: { email },
        });

        if (existingUser) {
          if (appwriteId && !existingUser.appwriteId) {
            const updatedUser = await prisma.user.update({
              where: { id: existingUser.id },
              data: { appwriteId },
            });
            return res.status(200).json(updatedUser.id);
          }
          return res.status(200).json(existingUser.id);
        }

        const user = await prisma.user.create({
          data: {
            appwriteId,
            firstName,
            lastName,
            email,
            apartmentNumber,
            phoneNumber,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        });
        res.status(201).json(user.id);
      } catch (error) {
        console.error("Error creating user:", error);
        res.status(500).json({
          error: "failed to create user",
        });
      }
      break;

    default:
      res.setHeader("Allow", ["GET", "POST"]);
      res.status(405).end(`Method ${method} Not Allowed`);
  }
}
