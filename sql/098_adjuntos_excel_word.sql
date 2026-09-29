-- 098: el bucket de adjuntos de WhatsApp acepta también Excel, CSV y Word (Pablo, 29/09).
-- Antes sólo imagen y PDF: una lista de pedido en Excel quedaba sin guardar y la tarea salía sin archivo.
-- Idempotente. No cambia el tamaño máximo (20 MB) ni la privacidad (sigue privado).
update storage.buckets
   set allowed_mime_types = array[
     'image/jpeg','image/png','image/webp','application/pdf',
     'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
     'text/csv','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document']
 where id = 'wa-comprobantes';
